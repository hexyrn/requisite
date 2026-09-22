import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { ScheduledJobService, JobHandlerRegistryService } from '../scheduled-job.service';
import { JobRunnerService } from '../job-runner.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Scheduled jobs - organisation context, retry, recurring (P1 item 14)', () => {
  let pool: Pool;
  let orgId: string;
  const jobService = new ScheduledJobService();
  const handlers = new JobHandlerRegistryService();
  const runner = new JobRunnerService(handlers);

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgId = await createTestOrg(pool, 'Scheduling Test Org');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('ORG CONTEXT: enqueue requires an organisationId - TypeScript enforces it at the call site (no optional overload)', async () => {
    // This is a compile-time guarantee (ScheduledJobService.enqueue's second
    // parameter is a required `string`), demonstrated at runtime by
    // confirming a normal enqueue call always carries organisation_id through
    // to the persisted row.
    const jobId = await withOrgContext(
      orgId,
      (db) =>
        jobService.enqueue(db, orgId, 'com.hexyrn.reference', 'send.reminder', { widgetId: 'w1' }),
      pool,
    );
    const row = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('scheduled_jobs')
          .selectAll()
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow(),
      pool,
    );
    expect(row.organisation_id).toBe(orgId);
  });

  it('a due job is executed by the runner, inside the correct organisation context', async () => {
    let sawOrgId: string | null = null;
    handlers.register('send.reminder', async (_db, organisationId) => {
      sawOrgId = organisationId;
    });

    await withOrgContext(
      orgId,
      (db) =>
        jobService.enqueue(
          db,
          orgId,
          'com.hexyrn.reference',
          'send.reminder',
          {},
          new Date(Date.now() - 1000),
        ),
      pool,
    );
    const { processed } = await runner.runDue(50, pool);
    expect(processed).toBeGreaterThanOrEqual(1);
    expect(sawOrgId).toBe(orgId);
  });

  it("SCHEDULED JOB ORGANISATION CONTEXT: a job for org B never executes its handler with org A's id, even when both are due simultaneously", async () => {
    const orgB = await createTestOrg(pool, 'Scheduling Org B');
    const seenOrgIds: string[] = [];
    handlers.register('track.org', async (_db, organisationId) => {
      seenOrgIds.push(organisationId);
    });

    await withOrgContext(
      orgId,
      (db) =>
        jobService.enqueue(
          db,
          orgId,
          'com.hexyrn.reference',
          'track.org',
          {},
          new Date(Date.now() - 1000),
        ),
      pool,
    );
    await withOrgContext(
      orgB,
      (db) =>
        jobService.enqueue(
          db,
          orgB,
          'com.hexyrn.reference',
          'track.org',
          {},
          new Date(Date.now() - 1000),
        ),
      pool,
    );

    await runner.runDue(50, pool);
    expect(seenOrgIds.sort()).toEqual([orgId, orgB].sort());
  });

  it('a job whose handler throws is retried (attempts increments, status back to pending, re-queued for later)', async () => {
    let attempts = 0;
    handlers.register('flaky.job', async () => {
      attempts++;
      if (attempts < 2) throw new Error('simulated failure');
    });

    const jobId = await withOrgContext(
      orgId,
      (db) =>
        jobService.enqueue(
          db,
          orgId,
          'com.hexyrn.reference',
          'flaky.job',
          {},
          new Date(Date.now() - 1000),
        ),
      pool,
    );
    await runner.runDue(50, pool);

    const afterFirstAttempt = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('scheduled_jobs')
          .selectAll()
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow(),
      pool,
    );
    expect(afterFirstAttempt.status).toBe('pending');
    expect(afterFirstAttempt.attempts).toBe(1);

    // Force the retry to be due now (the real backoff is 30s) and run again.
    await withOrgContext(
      orgId,
      (db) =>
        db
          .updateTable('dispatch_queue')
          .set({ due_at: new Date(Date.now() - 1000) as any })
          .where('kind', '=', 'job')
          .execute(),
      pool,
    );
    await runner.runDue(50, pool);

    const afterSecondAttempt = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('scheduled_jobs')
          .selectAll()
          .where('id', '=', jobId)
          .executeTakeFirstOrThrow(),
      pool,
    );
    expect(afterSecondAttempt.status).toBe('completed');
    expect(attempts).toBe(2);
  });

  it('a job that exhausts max_attempts is marked permanently failed, not retried forever', async () => {
    handlers.register('always.fails', async () => {
      throw new Error('always fails');
    });

    const jobId = await withOrgContext(
      orgId,
      (db) =>
        db
          .insertInto('scheduled_jobs')
          .values({
            organisation_id: orgId,
            app_id: 'com.hexyrn.reference',
            job_type: 'always.fails',
            payload: {},
            run_at: new Date(Date.now() - 1000) as any,
            max_attempts: 2,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      pool,
    );
    await withOrgContext(
      orgId,
      (db) =>
        db
          .insertInto('dispatch_queue')
          .values({
            organisation_id: orgId,
            kind: 'job',
            ref_id: jobId.id,
            due_at: new Date(Date.now() - 1000) as any,
          })
          .execute(),
      pool,
    );

    await runner.runDue(50, pool); // attempt 1 -> pending, retry queued
    await withOrgContext(
      orgId,
      (db) =>
        db
          .updateTable('dispatch_queue')
          .set({ due_at: new Date(Date.now() - 1000) as any })
          .where('kind', '=', 'job')
          .where('ref_id', '=', jobId.id)
          .execute(),
      pool,
    );
    await runner.runDue(50, pool); // attempt 2 -> failed permanently (max_attempts=2)

    const final = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('scheduled_jobs')
          .selectAll()
          .where('id', '=', jobId.id)
          .executeTakeFirstOrThrow(),
      pool,
    );
    expect(final.status).toBe('failed');
    expect(final.attempts).toBe(2);

    // And the routing queue entry is gone - it will never be picked up again.
    const queueEntry = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('dispatch_queue')
          .selectAll()
          .where('ref_id', '=', jobId.id)
          .executeTakeFirst(),
      pool,
    );
    expect(queueEntry).toBeUndefined();
  });

  it('a recurring job re-enqueues itself on completion', async () => {
    let runs = 0;
    handlers.register('recurring.job', async () => {
      runs++;
    });

    await withOrgContext(
      orgId,
      (db) =>
        jobService.enqueue(
          db,
          orgId,
          'com.hexyrn.reference',
          'recurring.job',
          {},
          new Date(Date.now() - 1000),
          3600,
        ),
      pool,
    );
    await runner.runDue(50, pool);
    expect(runs).toBe(1);

    const jobs = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('scheduled_jobs')
          .selectAll()
          .where('job_type', '=', 'recurring.job')
          .execute(),
      pool,
    );
    expect(jobs).toHaveLength(2); // the completed one + the next occurrence
    expect(jobs.filter((j) => j.status === 'completed')).toHaveLength(1);
    expect(jobs.filter((j) => j.status === 'pending')).toHaveLength(1);
  });
});
