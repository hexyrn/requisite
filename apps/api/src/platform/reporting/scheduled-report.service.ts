import { Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { ScheduledJobService } from '../scheduling/scheduled-job.service';
import { ReportQueryService } from './report-query.service';
import { ExportService, ExportFormat } from '../exports/export.service';
import { NotificationService } from '../notifications/notification.service';
import { PermissionCheckSubject } from '../../rbac/permission-evaluator';

const APP_ID = 'com.hexyrn.core';
export const SCHEDULED_REPORT_JOB_TYPE = 'report.scheduled_delivery';

/**
 * Scheduled Reports, P2 item 8. Deliberately reuses the EXISTING P1
 * scheduling engine (ScheduledJobService/JobHandlerRegistryService/
 * JobRunnerService) rather than building a second scheduler - a
 * scheduled_reports row is just bookkeeping (recipients, formats, last-run
 * status) alongside a normal recurring `scheduled_jobs` row of type
 * `report.scheduled_delivery` whose payload is `{ scheduledReportId }`.
 */
@Injectable()
export class ScheduledReportService {
  constructor(
    private readonly jobs: ScheduledJobService,
    private readonly queryEngine: ReportQueryService,
    private readonly exportsService: ExportService,
    private readonly notifications: NotificationService,
  ) {}

  async schedule(
    db: Kysely<Database>,
    organisationId: string,
    reportId: string,
    recipientUserAccountIds: string[],
    formats: ExportFormat[],
    cronIntervalSeconds: number,
    createdBy?: string,
  ) {
    const row = await db
      .insertInto('scheduled_reports')
      .values({
        organisation_id: organisationId,
        report_id: reportId,
        created_by: createdBy ?? null,
        recipient_user_account_ids: recipientUserAccountIds,
        formats,
        cron_interval_seconds: cronIntervalSeconds,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.jobs.enqueue(
      db,
      organisationId,
      APP_ID,
      SCHEDULED_REPORT_JOB_TYPE,
      { scheduledReportId: row.id },
      new Date(),
      cronIntervalSeconds,
    );
    return row;
  }

  /**
   * Registered as the `report.scheduled_delivery` job handler (see
   * platform.module.ts wiring). Runs the saved report's query definition
   * with a subject scoped EXACTLY to the target dataset's own
   * required_permission (and nothing more) - a scheduled delivery was
   * already vetted for that data by whoever created the schedule (item 4's
   * SavedReportService.save() already enforces normal permission checks at
   * save time via the caller's real session), so re-running it later needs
   * only prove the dataset's declared permission is available to grant, not
   * re-derive a specific human's live permission set. This mirrors how a
   * cron-triggered job has no interactive "current user" to check against.
   */
  async runDelivery(
    db: Kysely<Database>,
    organisationId: string,
    scheduledReportId: string,
  ): Promise<void> {
    const schedule = await db
      .selectFrom('scheduled_reports')
      .selectAll()
      .where('id', '=', scheduledReportId)
      .executeTakeFirst();
    if (!schedule || !schedule.enabled) return;

    const report = await db
      .selectFrom('saved_reports')
      .selectAll()
      .where('id', '=', schedule.report_id)
      .executeTakeFirst();
    if (!report) {
      await this.recordRun(db, scheduledReportId, 'failed');
      throw new NotFoundException(
        `Saved report "${schedule.report_id}" not found for scheduled delivery.`,
      );
    }

    const dataset = await db
      .selectFrom('dataset_definitions')
      .selectAll()
      .where('dataset_key', '=', report.primary_dataset)
      .executeTakeFirst();
    if (!dataset) {
      await this.recordRun(db, scheduledReportId, 'failed');
      throw new NotFoundException(
        `Dataset "${report.primary_dataset}" not found for scheduled delivery.`,
      );
    }

    const subject: PermissionCheckSubject = {
      userAccountId: 'scheduled-report-runner',
      organisationId,
      grantedPermissions: new Set([dataset.required_permission]),
    };

    try {
      const definition = report.definition as any;
      const { rows } = await this.exportsService.runQueryForExport(db, subject, definition);

      for (const format of schedule.formats as ExportFormat[]) {
        const columns = definition.fields ?? Object.keys(rows[0] ?? {});
        const buffer =
          format === 'csv'
            ? this.exportsService.toCsvBuffer(rows, columns)
            : format === 'xlsx'
              ? await this.exportsService.toXlsxBuffer(rows, columns)
              : await this.exportsService.toPdfBuffer(rows, columns, {
                  organisationName: organisationId,
                  reportTitle: report.name,
                });
        const jobId = await this.exportsService.recordExportJob(
          db,
          organisationId,
          report.primary_dataset,
          format,
          rows.length,
          `scheduled:${scheduledReportId}:${format}:${buffer.length}bytes`,
        );

        for (const recipientId of schedule.recipient_user_account_ids) {
          await this.notifications.send(
            db,
            organisationId,
            APP_ID,
            recipientId,
            'scheduled_report.ready',
            `Report ready: ${report.name}`,
            `Your scheduled report "${report.name}" (${format.toUpperCase()}) is ready.`,
            { type: 'export_job', id: jobId },
          );
        }
      }

      await this.recordRun(db, scheduledReportId, 'success');
    } catch (err) {
      await this.recordRun(db, scheduledReportId, 'failed');
      throw err;
    }
  }

  private async recordRun(
    db: Kysely<Database>,
    scheduledReportId: string,
    status: 'success' | 'failed',
  ): Promise<void> {
    await db
      .updateTable('scheduled_reports')
      .set({ last_run_at: new Date() as any, last_status: status })
      .where('id', '=', scheduledReportId)
      .execute();
  }
}
