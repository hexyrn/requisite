import { Inject, Injectable, Optional } from '@nestjs/common';
import { Pool } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Database } from '../../db/types';
import { getPool } from '../../db/pool';
import { withOrgContext } from '../../db/org-context';
import { WebhookService } from './webhook.service';
import { WEBHOOK_SENDER, WebhookSender, HttpWebhookSender } from './webhook-sender';
import { logStructured } from '../../logging/logger';

const MAX_DELIVERY_ATTEMPTS = 5;
const PAYLOAD_SCHEMA_VERSION = 1;

/**
 * Delivers pending webhook work discovered via dispatch_queue(kind='webhook')
 * - see event-publisher.service.ts for why this is a SEPARATE routing row
 * from the in-process event dispatcher's 'event' entries. Mirrors
 * EventDispatcherService's structure exactly (P2 item 14), including the
 * same "only the outer claim/release/delete loop may mutate a
 * dispatch_queue row's fate" rule that a real P1 bug taught us matters.
 */
@Injectable()
export class WebhookDispatcherService {
  constructor(
    private readonly webhooks: WebhookService,
    @Optional() @Inject(WEBHOOK_SENDER) private readonly sender: WebhookSender = new HttpWebhookSender(),
  ) {}

  async dispatchPending(limit = 50, pool: Pool = getPool()): Promise<{ processed: number }> {
    const routingDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const dueEntries = await routingDb
      .selectFrom('dispatch_queue')
      .selectAll()
      .where('kind', '=', 'webhook')
      .where('claimed_at', 'is', null)
      .orderBy('due_at', 'asc')
      .limit(limit)
      .execute();

    let processed = 0;
    for (const entry of dueEntries) {
      await routingDb.updateTable('dispatch_queue').set({ claimed_at: new Date() }).where('id', '=', entry.id).execute();
      const fullyDispatched = await this.dispatchOne(entry.organisation_id, entry.ref_id, pool);
      if (fullyDispatched) {
        await routingDb.deleteFrom('dispatch_queue').where('id', '=', entry.id).execute();
      } else {
        await routingDb.updateTable('dispatch_queue').set({ claimed_at: null }).where('id', '=', entry.id).execute();
      }
      processed++;
    }
    return { processed };
  }

  private async dispatchOne(organisationId: string, eventId: string, pool: Pool): Promise<boolean> {
    return withOrgContext(
      organisationId,
      async (db) => {
        const event = await db.selectFrom('event_outbox').selectAll().where('id', '=', eventId).executeTakeFirst();
        if (!event) return true;

        const endpoints = await db
          .selectFrom('webhook_endpoints')
          .selectAll()
          .where('organisation_id', '=', organisationId)
          .where('is_enabled', '=', true)
          .where(sql<boolean>`${event.event_type} = ANY(event_types) OR '*' = ANY(event_types)`)
          .execute();

        let allTerminal = true;
        for (const endpoint of endpoints) {
          const outcome = await this.deliverToEndpoint(db, organisationId, eventId, event.event_type, event.payload as Record<string, unknown>, endpoint);
          if (outcome === 'retry') allTerminal = false;
        }
        return allTerminal;
      },
      pool,
    );
  }

  private async deliverToEndpoint(
    db: Kysely<Database>,
    organisationId: string,
    eventId: string,
    eventType: string,
    payload: Record<string, unknown>,
    endpoint: { id: string; url: string; signing_key_encrypted: string },
  ): Promise<'delivered' | 'retry' | 'failed-terminal'> {
    const existing = await db.selectFrom('webhook_deliveries').selectAll().where('event_id', '=', eventId).where('endpoint_id', '=', endpoint.id).executeTakeFirst();
    if (existing?.status === 'delivered') return 'delivered';

    const attemptCount = (existing?.attempt_count ?? 0) + 1;
    const body = JSON.stringify({ eventId, eventType, payloadVersion: PAYLOAD_SCHEMA_VERSION, data: payload });
    const signingKey = this.webhooks.decryptSigningKey(endpoint.signing_key_encrypted);
    const signature = this.webhooks.sign(body, signingKey);

    const result = await this.sender.send(endpoint.url, body, {
      'content-type': 'application/json',
      'x-hexyrn-signature': signature,
      'x-hexyrn-event-type': eventType,
      'x-hexyrn-payload-version': String(PAYLOAD_SCHEMA_VERSION),
    });

    const status = result.success ? 'delivered' : attemptCount >= MAX_DELIVERY_ATTEMPTS ? 'failed' : 'pending_retry';

    await db
      .insertInto('webhook_deliveries')
      .values({
        organisation_id: organisationId,
        endpoint_id: endpoint.id,
        event_id: eventId,
        event_type: eventType,
        payload_version: PAYLOAD_SCHEMA_VERSION,
        status,
        attempt_count: attemptCount,
        last_response_status: result.statusCode ?? null,
        last_error: result.error ?? null,
        delivered_at: result.success ? (new Date() as any) : null,
      })
      .onConflict((oc) =>
        oc.columns(['endpoint_id', 'event_id']).doUpdateSet({
          status,
          attempt_count: attemptCount,
          last_response_status: result.statusCode ?? null,
          last_error: result.error ?? null,
          delivered_at: result.success ? (new Date() as any) : null,
        }),
      )
      .execute();

    if (!result.success) {
      logStructured({ event: 'webhook.delivery.failed', errorCode: 'WEBHOOK_DELIVERY_FAILED', context: { eventType, attemptCount, statusCode: result.statusCode } });
    }

    if (result.success) return 'delivered';
    return attemptCount >= MAX_DELIVERY_ATTEMPTS ? 'failed-terminal' : 'retry';
  }
}
