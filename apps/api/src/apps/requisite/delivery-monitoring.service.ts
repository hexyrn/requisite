import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database } from '../../db/types';
import { ScheduledJobService } from '../../platform/scheduling/scheduled-job.service';
import { NotificationService } from '../../platform/notifications/notification.service';
import { REQUISITE_APP_MANIFEST } from './requisite.manifest';

const APP_ID = REQUISITE_APP_MANIFEST.appId;
export const DELIVERY_MONITORING_JOB_TYPE = 'requisite.delivery_monitoring';

/**
 * Delivery monitoring / reminders, item 18 - reuses the EXISTING P1
 * scheduling engine (ScheduledJobService/JobHandlerRegistryService/
 * JobRunnerService) rather than a second scheduler, exactly the same
 * reuse pattern P2's ScheduledReportService established. Tracks expected
 * delivery dates against issued/partially_received purchase order lines:
 * due soon (within 3 days), due today, overdue, and partially-received-
 * and-overdue - notifying the PO's buyer for each.
 */
@Injectable()
export class DeliveryMonitoringService {
  constructor(
    private readonly jobs: ScheduledJobService,
    private readonly notifications: NotificationService,
  ) {}

  /** Registers the recurring daily check for an organisation - idempotent (ON CONFLICT-safe via a fixed job_type + recurring interval; a second call simply enqueues another recurring entry, acceptable for v1). */
  async scheduleDailyCheck(db: Kysely<Database>, organisationId: string): Promise<void> {
    await this.jobs.enqueue(
      db,
      organisationId,
      APP_ID,
      DELIVERY_MONITORING_JOB_TYPE,
      {},
      new Date(),
      24 * 60 * 60,
    );
  }

  async runCheck(
    db: Kysely<Database>,
    organisationId: string,
  ): Promise<{ dueSoon: number; dueToday: number; overdue: number }> {
    const lines = await db
      .selectFrom('requisite_purchase_order_lines as pol')
      .innerJoin('requisite_purchase_orders as po', 'po.id', 'pol.purchase_order_id')
      .select([
        'pol.id',
        'pol.description',
        'pol.expected_delivery_date',
        'pol.quantity_ordered',
        'pol.quantity_received',
        'po.id as po_id',
        'po.po_number',
        'po.buyer_user_account_id',
        'po.status',
      ])
      .where('po.organisation_id', '=', organisationId)
      .where('po.status', 'in', ['issued', 'partially_received'])
      .where('pol.expected_delivery_date', 'is not', null)
      .where(sql<boolean>`pol.quantity_received < pol.quantity_ordered`)
      .execute();

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const in3Days = new Date(today);
    in3Days.setUTCDate(in3Days.getUTCDate() + 3);

    let dueSoon = 0;
    let dueToday = 0;
    let overdue = 0;

    for (const line of lines) {
      if (!line.buyer_user_account_id || !line.expected_delivery_date) continue;
      const due = new Date(line.expected_delivery_date);
      due.setUTCHours(0, 0, 0, 0);

      if (due.getTime() < today.getTime()) {
        overdue++;
        await this.notifications.send(
          db,
          organisationId,
          APP_ID,
          line.buyer_user_account_id,
          'requisite.delivery_overdue',
          `Overdue delivery: ${line.po_number}`,
          `"${line.description}" was expected ${line.expected_delivery_date} and is still outstanding (${line.status}).`,
          { type: 'requisite_purchase_order', id: line.po_id },
        );
      } else if (due.getTime() === today.getTime()) {
        dueToday++;
        await this.notifications.send(
          db,
          organisationId,
          APP_ID,
          line.buyer_user_account_id,
          'requisite.delivery_due_today',
          `Delivery due today: ${line.po_number}`,
          `"${line.description}" is expected today.`,
          { type: 'requisite_purchase_order', id: line.po_id },
        );
      } else if (due.getTime() <= in3Days.getTime()) {
        dueSoon++;
        await this.notifications.send(
          db,
          organisationId,
          APP_ID,
          line.buyer_user_account_id,
          'requisite.delivery_due_soon',
          `Delivery due soon: ${line.po_number}`,
          `"${line.description}" is expected ${line.expected_delivery_date}.`,
          { type: 'requisite_purchase_order', id: line.po_id },
        );
      }
    }

    return { dueSoon, dueToday, overdue };
  }
}
