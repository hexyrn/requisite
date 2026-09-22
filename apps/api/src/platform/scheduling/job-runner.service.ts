import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { Database } from '../../db/types';
import { getPool } from '../../db/pool';
import { withOrgContext } from '../../db/org-context';
import { JobHandlerRegistryService } from './scheduled-job.service';
import { logStructured } from '../../logging/logger';

const BACKOFF_SECONDS = 30;

/**
 * Executes due jobs. Every job handler invocation runs inside
 * withOrgContext(job.organisation_id, ...) - the P0 invariant ("every
 * execution context accessing organisation-owned data has an explicit
 * organisation context") applies identically here to a background
 * execution context, per Architecture §8.1 and the P1 brief's item 4/14
 * requirement. A job whose row is missing its organisation context cannot
 * exist in the first place (NOT NULL column, required service parameter) -
 * there is no runtime "job has no org, run it anyway" path to fail open on.
 */
@Injectable()
export class JobRunnerService {
  constructor(private readonly handlers: JobHandlerRegistryService) {}

  async runDue(limit = 50, pool: Pool = getPool()): Promise<{ processed: number }> {
    const routingDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const dueEntries = await routingDb
      .selectFrom('dispatch_queue')
      .selectAll()
      .where('kind', '=', 'job')
      .where('claimed_at', 'is', null)
      .where('due_at', '<=', new Date() as any)
      .orderBy('due_at', 'asc')
      .limit(limit)
      .execute();

    let processed = 0;
    for (const entry of dueEntries) {
      await routingDb
        .updateTable('dispatch_queue')
        .set({ claimed_at: new Date() as any })
        .where('id', '=', entry.id)
        .execute();
      const { terminal, retryAt } = await this.runOne(entry.organisation_id, entry.ref_id, pool);
      if (terminal) {
        // See the identical note in EventDispatcherService.dispatchPending -
        // this loop is the ONLY place that inserts/deletes/clears this
        // specific routing entry; runOne must never touch dispatch_queue
        // for its OWN entry, or its decision races against this cleanup.
        await routingDb.deleteFrom('dispatch_queue').where('id', '=', entry.id).execute();
      } else {
        await routingDb
          .updateTable('dispatch_queue')
          .set({ claimed_at: null, due_at: (retryAt ?? new Date()) as any })
          .where('id', '=', entry.id)
          .execute();
      }
      processed++;
    }
    return { processed };
  }

  /** Returns whether the job reached a terminal state (completed/failed-permanently/gone), and a retry time if not. */
  private async runOne(
    organisationId: string,
    jobId: string,
    pool: Pool,
  ): Promise<{ terminal: boolean; retryAt?: Date }> {
    return withOrgContext(
      organisationId,
      async (db) => {
        const job = await db
          .selectFrom('scheduled_jobs')
          .selectAll()
          .where('id', '=', jobId)
          .executeTakeFirst();
        if (!job || job.status !== 'pending') return { terminal: true };

        await db
          .updateTable('scheduled_jobs')
          .set({ status: 'running' })
          .where('id', '=', jobId)
          .execute();

        const handler = this.handlers.get(job.job_type);
        try {
          if (!handler) throw new Error(`No handler registered for job type "${job.job_type}".`);
          await handler(db, organisationId, job.payload as Record<string, unknown>);
          await db
            .updateTable('scheduled_jobs')
            .set({ status: 'completed', completed_at: new Date() as any })
            .where('id', '=', jobId)
            .execute();

          if (job.recurring_interval_seconds) {
            const nextRunAt = new Date(Date.now() + job.recurring_interval_seconds * 1000);
            const next = await db
              .insertInto('scheduled_jobs')
              .values({
                organisation_id: organisationId,
                app_id: job.app_id,
                job_type: job.job_type,
                payload: job.payload,
                run_at: nextRunAt as any,
                recurring_interval_seconds: job.recurring_interval_seconds,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            // A different ref_id (the NEW job's id) - never collides with
            // the current entry, which the caller will delete after this returns.
            await db
              .insertInto('dispatch_queue')
              .values({
                organisation_id: organisationId,
                kind: 'job',
                ref_id: next.id,
                due_at: nextRunAt as any,
              })
              .execute();
          }
          return { terminal: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const attempts = job.attempts + 1;
          const failed = attempts >= job.max_attempts;
          await db
            .updateTable('scheduled_jobs')
            .set({ status: failed ? 'failed' : 'pending', attempts, last_error: message })
            .where('id', '=', jobId)
            .execute();
          logStructured({
            event: 'job.execution.failed',
            errorCode: 'JOB_HANDLER_ERROR',
            context: { jobType: job.job_type, attempts, failed },
          });

          return failed
            ? { terminal: true }
            : { terminal: false, retryAt: new Date(Date.now() + BACKOFF_SECONDS * 1000) };
        }
      },
      pool,
    );
  }
}
