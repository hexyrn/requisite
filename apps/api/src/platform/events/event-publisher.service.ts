import { Injectable, Optional } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database } from '../../db/types';
import { EventSchemaService } from './event-schema.service';

/**
 * Transactional outbox write. Architecture's carried-forward "transactional
 * event outbox" design, P1 item 4. `publish` is called with the SAME `db`
 * handle (and therefore the same withOrgContext transaction) as the domain
 * change that caused the event, so the event row and the business row
 * either both commit or both roll back - there is no window where the
 * domain change committed but the event was lost, or vice versa.
 */
@Injectable()
export class EventPublisherService {
  constructor(@Optional() private readonly schemas?: EventSchemaService) {}

  async publish(
    db: Kysely<Database>,
    organisationId: string,
    producerAppId: string,
    eventType: string,
    payload: Record<string, unknown>,
    version = 1,
  ): Promise<string> {
    if (this.schemas) {
      await this.schemas.validate(db, eventType, version, payload);
    }

    const row = await db
      .insertInto('event_outbox')
      .values({
        organisation_id: organisationId,
        event_type: eventType,
        event_version: version,
        producer_app_id: producerAppId,
        payload: payload as any,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Routing pointer only (no payload) - see docs/decisions/0005 for why
    // this table has no RLS and why that's safe. Same transaction as the
    // event row above, so publication and "is discoverable for dispatch"
    // are atomic.
    await db
      .insertInto('dispatch_queue')
      .values({ organisation_id: organisationId, kind: 'event', ref_id: row.id })
      .execute();

    // P2 item 14: a SEPARATE 'webhook' routing entry, only when at least one
    // enabled webhook_endpoint actually subscribes to this event type (or to
    // '*') - avoids queuing webhook work for orgs/events with no
    // subscribers. This is a distinct dispatch_queue row (own kind) from the
    // 'event' entry above specifically so the in-process consumer dispatcher
    // (EventDispatcherService) and the webhook dispatcher never contend over
    // the SAME routing row's claimed_at/delete fate - each owns only its own
    // kind, following the established rule that only one loop may ever
    // mutate a given dispatch_queue row.
    const subscribed = await db
      .selectFrom('webhook_endpoints')
      .select('id')
      .where('organisation_id', '=', organisationId)
      .where('is_enabled', '=', true)
      .where(sql<boolean>`${eventType} = ANY(event_types) OR '*' = ANY(event_types)`)
      .executeTakeFirst();
    if (subscribed) {
      await db
        .insertInto('dispatch_queue')
        .values({ organisation_id: organisationId, kind: 'webhook', ref_id: row.id })
        .execute();
    }

    return row.id;
  }
}
