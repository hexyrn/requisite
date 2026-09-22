import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

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
  async publish(
    db: Kysely<Database>,
    organisationId: string,
    producerAppId: string,
    eventType: string,
    payload: Record<string, unknown>,
    version = 1,
  ): Promise<string> {
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

    return row.id;
  }
}
