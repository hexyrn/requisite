import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { Database } from '../../db/types';
import { getPool } from '../../db/pool';
import { withOrgContext } from '../../db/org-context';
import { ApplicationRegistryService } from '../app-registry/application-registry.service';
import { EventHandlerRegistryService } from './event-handler-registry.service';
import { logStructured } from '../../logging/logger';

const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Delivers pending events to their registered consumers. Architecture §4:
 * "A publisher must continue operating if an optional consumer application
 * is absent" (a consumer that isn't installed/active is simply skipped, not
 * an error), "the outbox must preserve organisation context explicitly"
 * (every delivery attempt runs inside withOrgContext(event.organisation_id,
 * ...) - the P0 invariant applies identically to this background context),
 * and delivery is idempotent (a delivery row already 'delivered' is never
 * re-invoked, so re-running the dispatcher after a partial failure cannot
 * double-apply a consumer's side effects for events it already handled).
 */
@Injectable()
export class EventDispatcherService {
  constructor(
    private readonly registry: ApplicationRegistryService,
    private readonly handlers: EventHandlerRegistryService,
  ) {}

  /**
   * Processes up to `limit` undispatched events. Discovery of WHICH
   * organisations have due work uses `dispatch_queue` (see ADR 0005) - a
   * routing-only table with no RLS, since finding cross-org due work is a
   * genuinely different problem from accessing any one org's data, which
   * always still goes through withOrgContext below.
   */
  async dispatchPending(limit = 50, pool: Pool = getPool()): Promise<{ processed: number }> {
    const routingDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const dueEntries = await routingDb
      .selectFrom('dispatch_queue')
      .selectAll()
      .where('kind', '=', 'event')
      .where('claimed_at', 'is', null)
      .orderBy('due_at', 'asc')
      .limit(limit)
      .execute();

    let processed = 0;
    for (const entry of dueEntries) {
      // Claim it (best-effort - a real multi-worker deployment would use
      // SELECT ... FOR UPDATE SKIP LOCKED here; P1 runs a single dispatcher).
      await routingDb
        .updateTable('dispatch_queue')
        .set({ claimed_at: new Date() })
        .where('id', '=', entry.id)
        .execute();
      const fullyDispatched = await this.dispatchOne(entry.organisation_id, entry.ref_id, pool);
      if (fullyDispatched) {
        // Terminal (all consumers delivered/skipped, or every failure hit
        // max attempts) - this routing entry is done, remove it.
        await routingDb.deleteFrom('dispatch_queue').where('id', '=', entry.id).execute();
      } else {
        // Still has retryable failures - leave the entry for a future pass,
        // just release the claim. IMPORTANT: this must be the only place
        // that decides the entry's fate - dispatchOne itself must never
        // insert/delete dispatch_queue rows, or its outcome would race
        // against this unconditional cleanup step (a real bug found via
        // this test: an insert-inside-dispatchOne meant to "re-queue" was
        // silently undone by this loop's own delete immediately afterward).
        await routingDb
          .updateTable('dispatch_queue')
          .set({ claimed_at: null })
          .where('id', '=', entry.id)
          .execute();
      }
      processed++;
    }
    return { processed };
  }

  /** Returns true if the event is now fully dispatched (nothing left to retry). */
  private async dispatchOne(organisationId: string, eventId: string, pool: Pool): Promise<boolean> {
    return withOrgContext(
      organisationId,
      async (db) => {
        const event = await db
          .selectFrom('event_outbox')
          .selectAll()
          .where('id', '=', eventId)
          .executeTakeFirst();
        if (!event) return true; // detail row gone - nothing to deliver (see ADR 0005's "fail-soft, never fail-open" note); treat as done so the routing entry is cleared.
        if (event.dispatched_at) return true; // already fully dispatched by an earlier pass.

        const payload = event.payload as Record<string, unknown>;
        const consumers = await db
          .selectFrom('event_consumer_registrations')
          .selectAll()
          .where('event_type', '=', event.event_type)
          .execute();

        let allTerminal = true;
        for (const consumer of consumers) {
          const outcome = await this.deliverToConsumer(
            db,
            organisationId,
            eventId,
            consumer.consumer_app_id,
            consumer.handler_ref,
            payload,
          );
          if (outcome === 'retry') allTerminal = false;
        }

        if (allTerminal) {
          await db
            .updateTable('event_outbox')
            .set({ dispatched_at: new Date() })
            .where('id', '=', eventId)
            .execute();
        }
        return allTerminal;
      },
      pool,
    );
  }

  private async deliverToConsumer(
    db: Kysely<Database>,
    organisationId: string,
    eventId: string,
    consumerAppId: string,
    handlerRef: string,
    payload: Record<string, unknown>,
  ): Promise<'delivered' | 'skipped' | 'retry' | 'failed-terminal'> {
    const existing = await db
      .selectFrom('event_deliveries')
      .selectAll()
      .where('event_id', '=', eventId)
      .where('consumer_app_id', '=', consumerAppId)
      .executeTakeFirst();

    if (existing?.status === 'delivered' || existing?.status === 'skipped') {
      return existing.status; // idempotent - already handled, never re-invoke.
    }

    const state = await this.registry.getApplicationState(db, organisationId, consumerAppId);
    if (!state.active) {
      await this.upsertDelivery(
        db,
        eventId,
        organisationId,
        consumerAppId,
        'skipped',
        existing?.attempt_count ?? 0,
      );
      return 'skipped';
    }

    const handler = this.handlers.get(handlerRef);
    const attemptCount = (existing?.attempt_count ?? 0) + 1;

    if (!handler) {
      await this.upsertDelivery(
        db,
        eventId,
        organisationId,
        consumerAppId,
        'failed',
        attemptCount,
        'No handler registered for this handler_ref',
      );
      return attemptCount >= MAX_DELIVERY_ATTEMPTS ? 'failed-terminal' : 'retry';
    }

    try {
      await handler(db, organisationId, payload);
      await this.upsertDelivery(
        db,
        eventId,
        organisationId,
        consumerAppId,
        'delivered',
        attemptCount,
      );
      return 'delivered';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.upsertDelivery(
        db,
        eventId,
        organisationId,
        consumerAppId,
        'failed',
        attemptCount,
        message,
      );
      logStructured({
        event: 'event.delivery.failed',
        errorCode: 'CONSUMER_HANDLER_ERROR',
        context: { eventType: handlerRef, attemptCount },
      });
      return attemptCount >= MAX_DELIVERY_ATTEMPTS ? 'failed-terminal' : 'retry';
    }
  }

  private async upsertDelivery(
    db: Kysely<Database>,
    eventId: string,
    organisationId: string,
    consumerAppId: string,
    status: string,
    attemptCount: number,
    lastError?: string,
  ): Promise<void> {
    await db
      .insertInto('event_deliveries')
      .values({
        event_id: eventId,
        organisation_id: organisationId,
        consumer_app_id: consumerAppId,
        status,
        attempt_count: attemptCount,
        last_error: lastError ?? null,
        delivered_at: status === 'delivered' ? new Date() : null,
      })
      .onConflict((oc) =>
        oc.columns(['event_id', 'consumer_app_id']).doUpdateSet({
          status,
          attempt_count: attemptCount,
          last_error: lastError ?? null,
          delivered_at: status === 'delivered' ? new Date() : null,
          updated_at: new Date(),
        }),
      )
      .execute();
  }
}
