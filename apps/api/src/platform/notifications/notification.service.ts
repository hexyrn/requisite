import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { logStructured } from '../../logging/logger';

/**
 * Notification framework. Architecture-required, P1 item 12. Applications
 * call `send()` rather than implementing their own email system - Core
 * owns delivery bookkeeping, read state, and (per-user, per-type, per-
 * channel) preferences. P1 ships two channels: in_app (a row the frontend
 * polls/reads) and email (logged via structured logging rather than an
 * actual SMTP send, since no mail transport exists yet - same documented
 * pattern as password-reset/invitation links in P0). `body` is treated as
 * potentially sensitive: the email "delivery" here logs only that a
 * notification of a given type was queued, never `body`/`title` themselves,
 * so notification content never leaks into logs.
 */
@Injectable()
export class NotificationService {
  async send(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
    recipientUserAccountId: string,
    notificationType: string,
    title: string,
    body: string,
    relatedEntity?: { type: string; id: string },
  ): Promise<string> {
    const preferences = await db
      .selectFrom('notification_preferences')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where('user_account_id', '=', recipientUserAccountId)
      .where('notification_type', '=', notificationType)
      .execute();

    const disabledChannels = new Set(preferences.filter((p) => !p.enabled).map((p) => p.channel));
    const channels = ['in_app', 'email'].filter((c) => !disabledChannels.has(c));

    const deliveryState: Record<string, string> = {};
    for (const channel of channels) {
      // in_app "delivery" is just the row existing; email is logged, not actually sent (no SMTP in P1 - documented, not silent).
      deliveryState[channel] = 'delivered';
      if (channel === 'email') {
        logStructured({ event: 'notification.email.queued', userRef: recipientUserAccountId, entityType: 'notification_type', entityRef: notificationType });
      }
    }

    const row = await db
      .insertInto('notifications')
      .values({
        organisation_id: organisationId,
        app_id: appId,
        recipient_user_account_id: recipientUserAccountId,
        notification_type: notificationType,
        title,
        body,
        related_entity_type: relatedEntity?.type ?? null,
        related_entity_id: relatedEntity?.id ?? null,
        channels: channels as any,
        delivery_state: deliveryState as any,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return row.id;
  }

  async listForUser(db: Kysely<Database>, organisationId: string, userAccountId: string, unreadOnly = false) {
    let query = db.selectFrom('notifications').selectAll().where('organisation_id', '=', organisationId).where('recipient_user_account_id', '=', userAccountId);
    if (unreadOnly) query = query.where('read_at', 'is', null);
    return query.orderBy('created_at', 'desc').execute();
  }

  async markRead(db: Kysely<Database>, organisationId: string, userAccountId: string, notificationId: string): Promise<void> {
    await db
      .updateTable('notifications')
      .set({ read_at: new Date() as any })
      .where('id', '=', notificationId)
      .where('organisation_id', '=', organisationId)
      .where('recipient_user_account_id', '=', userAccountId) // a user may only mark THEIR OWN notifications read - IDOR guard
      .execute();
  }

  async setPreference(db: Kysely<Database>, organisationId: string, userAccountId: string, notificationType: string, channel: string, enabled: boolean): Promise<void> {
    await db
      .insertInto('notification_preferences')
      .values({ organisation_id: organisationId, user_account_id: userAccountId, notification_type: notificationType, channel, enabled })
      .onConflict((oc) => oc.columns(['organisation_id', 'user_account_id', 'notification_type', 'channel']).doUpdateSet({ enabled }))
      .execute();
  }
}
