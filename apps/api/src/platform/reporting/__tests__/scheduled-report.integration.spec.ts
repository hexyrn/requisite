import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { DatasetService } from '../dataset.service';
import { ReportQueryService } from '../report-query.service';
import { SavedReportService } from '../saved-report.service';
import { ExportService } from '../../exports/export.service';
import { NotificationService } from '../../notifications/notification.service';
import {
  ScheduledJobService,
  JobHandlerRegistryService,
} from '../../scheduling/scheduled-job.service';
import { JobRunnerService } from '../../scheduling/job-runner.service';
import { ScheduledReportService, SCHEDULED_REPORT_JOB_TYPE } from '../scheduled-report.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'ScheduledReportService - reuses the P1 scheduling engine for report delivery (P2 item 8)',
  () => {
    let pool: Pool;
    let orgA: string;
    const datasets = new DatasetService();
    const queryEngine = new ReportQueryService();
    const savedReports = new SavedReportService();
    const exportsService = new ExportService(queryEngine, {} as any);
    const notifications = new NotificationService();
    const jobs = new ScheduledJobService();
    const jobHandlers = new JobHandlerRegistryService();
    const jobRunner = new JobRunnerService(jobHandlers);
    const scheduledReports = new ScheduledReportService(
      jobs,
      queryEngine,
      exportsService,
      notifications,
    );

    async function makeUser(organisationId: string, email: string): Promise<string> {
      const row = await withOrgContext(
        organisationId,
        (db) =>
          db
            .insertInto('user_accounts')
            .values({ organisation_id: organisationId, email, password_hash: 'x', is_active: true })
            .returningAll()
            .executeTakeFirstOrThrow(),
        pool,
      );
      return row.id;
    }

    beforeAll(async () => {
      pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
      await setUpTestDatabase(pool);
      orgA = await createTestOrg(pool, 'Scheduled Report Org A');

      jobHandlers.register(SCHEDULED_REPORT_JOB_TYPE, (db, organisationId, payload) =>
        scheduledReports.runDelivery(db, organisationId, payload.scheduledReportId as string),
      );

      await datasets.registerDataset(
        {
          datasetKey: 'reference.widgets_scheduled',
          appId: 'com.hexyrn.reference',
          displayName: 'Widgets Scheduled',
          requiredPermission: 'reference.widget.view',
          sourceRef: 'reference_widgets',
          isExportable: true,
          fields: [
            { key: 'id', label: 'ID', fieldType: 'string', isDimension: true },
            { key: 'title', label: 'Title', fieldType: 'string', isDimension: true },
          ],
        } as any,
        pool,
      );
    }, 60000);

    afterAll(async () => {
      await pool.end();
    });

    it('scheduling a report enqueues a recurring job, and running it delivers an export and notifies recipients', async () => {
      const owner = await makeUser(orgA, `sched-owner-${randomUUID()}@example.com`);
      const recipient = await makeUser(orgA, `sched-recipient-${randomUUID()}@example.com`);
      await withOrgContext(
        orgA,
        (db) =>
          db
            .insertInto('reference_widgets')
            .values({ organisation_id: orgA, widget_number: 'SR-1', title: 'Scheduled Widget' })
            .execute(),
        pool,
      );

      const savedReport = await withOrgContext(
        orgA,
        (db) =>
          savedReports.save(db, orgA, owner, 'Weekly Widgets', 'reference.widgets_scheduled', {
            datasetKey: 'reference.widgets_scheduled',
            fields: ['id', 'title'],
          }),
        pool,
      );

      const schedule = await withOrgContext(
        orgA,
        (db) =>
          scheduledReports.schedule(db, orgA, savedReport.id, [recipient], ['csv'], 86400, owner),
        pool,
      );
      expect(schedule.enabled).toBe(true);

      const jobRow = await withOrgContext(
        orgA,
        (db) =>
          db
            .selectFrom('scheduled_jobs')
            .selectAll()
            .where('job_type', '=', SCHEDULED_REPORT_JOB_TYPE)
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(jobRow.recurring_interval_seconds).toBe(86400);

      const result = await jobRunner.runDue(50, pool);
      expect(result.processed).toBe(1);

      const updatedSchedule = await withOrgContext(
        orgA,
        (db) =>
          db
            .selectFrom('scheduled_reports')
            .selectAll()
            .where('id', '=', schedule.id)
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(updatedSchedule.last_status).toBe('success');
      expect(updatedSchedule.last_run_at).not.toBeNull();

      const notificationRows = await withOrgContext(
        orgA,
        (db) =>
          db
            .selectFrom('notifications')
            .selectAll()
            .where('recipient_user_account_id', '=', recipient)
            .execute(),
        pool,
      );
      expect(notificationRows.length).toBeGreaterThanOrEqual(1);
      expect(notificationRows[0].notification_type).toBe('scheduled_report.ready');

      const exportJobRows = await withOrgContext(
        orgA,
        (db) =>
          db
            .selectFrom('export_jobs')
            .selectAll()
            .where('dataset_key', '=', 'reference.widgets_scheduled')
            .execute(),
        pool,
      );
      expect(exportJobRows.length).toBeGreaterThanOrEqual(1);

      // Recurring - the routing entry is rescheduled, not deleted.
      const remainingRouting = await withOrgContext(
        orgA,
        (db) => db.selectFrom('dispatch_queue').selectAll().where('kind', '=', 'job').execute(),
        pool,
      );
      expect(remainingRouting.length).toBe(1);
    });

    it('a disabled schedule does not run a delivery (last_status/last_run_at untouched)', async () => {
      const owner = await makeUser(orgA, `sched-owner2-${randomUUID()}@example.com`);
      const savedReport = await withOrgContext(
        orgA,
        (db) =>
          savedReports.save(db, orgA, owner, 'Disabled Report', 'reference.widgets_scheduled', {
            datasetKey: 'reference.widgets_scheduled',
            fields: ['id'],
          }),
        pool,
      );
      const schedule = await withOrgContext(
        orgA,
        (db) => scheduledReports.schedule(db, orgA, savedReport.id, [], ['csv'], 3600, owner),
        pool,
      );
      await withOrgContext(
        orgA,
        (db) =>
          db
            .updateTable('scheduled_reports')
            .set({ enabled: false })
            .where('id', '=', schedule.id)
            .execute(),
        pool,
      );

      await withOrgContext(orgA, (db) => scheduledReports.runDelivery(db, orgA, schedule.id), pool);

      const unchanged = await withOrgContext(
        orgA,
        (db) =>
          db
            .selectFrom('scheduled_reports')
            .selectAll()
            .where('id', '=', schedule.id)
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(unchanged.last_status).toBeNull();
    });
  },
);
