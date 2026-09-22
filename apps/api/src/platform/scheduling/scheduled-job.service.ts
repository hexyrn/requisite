import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

export type JobHandler = (db: Kysely<Database>, organisationId: string, payload: Record<string, unknown>) => Promise<void>;

/** In-process job_type -> handler map, same pattern/reasoning as EventHandlerRegistryService. */
@Injectable()
export class JobHandlerRegistryService {
  private readonly handlers = new Map<string, JobHandler>();
  register(jobType: string, handler: JobHandler): void {
    this.handlers.set(jobType, handler);
  }
  get(jobType: string): JobHandler | undefined {
    return this.handlers.get(jobType);
  }
}

/**
 * Scheduling / background jobs. Architecture-required, P1 item 14.
 * `organisationId` is a required parameter (no overload omitting it,
 * matching withOrgContext's own rule at §8.1) - a job simply cannot be
 * constructed without an explicit organisation, and the column itself is
 * `NOT NULL` (migration 0021), so even a hypothetical direct-SQL bypass of
 * this service could not create an org-less job row.
 */
@Injectable()
export class ScheduledJobService {
  async enqueue(db: Kysely<Database>, organisationId: string, appId: string, jobType: string, payload: Record<string, unknown>, runAt: Date = new Date(), recurringIntervalSeconds?: number): Promise<string> {
    const row = await db
      .insertInto('scheduled_jobs')
      .values({
        organisation_id: organisationId,
        app_id: appId,
        job_type: jobType,
        payload: payload as any,
        run_at: runAt as any,
        recurring_interval_seconds: recurringIntervalSeconds ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Routing pointer only - see docs/decisions/0005-cross-org-background-enumeration.md.
    await db.insertInto('dispatch_queue').values({ organisation_id: organisationId, kind: 'job', ref_id: row.id, due_at: runAt as any }).execute();

    return row.id;
  }
}
