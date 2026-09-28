import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { PostgresDialect } from 'kysely';
import { Database } from '../../db/types';
import { getPool } from '../../db/pool';
import { ReportQueryService } from '../reporting/report-query.service';
import { PermissionCheckSubject } from '../../rbac/permission-evaluator';

export type WidgetType =
  'kpi' | 'table' | 'bar_chart' | 'line_chart' | 'pie_chart' | 'status_queue' | 'alert_list';

export interface WidgetDefinitionInput {
  widgetKey: string;
  appId: string;
  displayName: string;
  widgetType: WidgetType;
  datasetKey: string;
  defaultConfig?: Record<string, unknown>;
}

/**
 * Dashboard framework. P2 item 6. Widget DATA always flows through
 * ReportQueryService.execute() - the exact same permission-aware path
 * used by ad-hoc reports. There is no second analytics query path: a
 * widget is just a saved ReportQueryDefinition plus layout metadata.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly queryEngine: ReportQueryService) {}

  async registerWidget(input: WidgetDefinitionInput, pool: Pool = getPool()): Promise<void> {
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    await db
      .insertInto('widget_definitions')
      .values({
        widget_key: input.widgetKey,
        app_id: input.appId,
        display_name: input.displayName,
        widget_type: input.widgetType,
        dataset_key: input.datasetKey,
        default_config: (input.defaultConfig ?? {}) as any,
      })
      .onConflict((oc) =>
        oc.column('widget_key').doUpdateSet({
          display_name: input.displayName,
          widget_type: input.widgetType,
          dataset_key: input.datasetKey,
        }),
      )
      .execute();
  }

  async createDashboard(
    db: Kysely<Database>,
    organisationId: string,
    ownerUserAccountId: string,
    name: string,
  ) {
    return db
      .insertInto('dashboards')
      .values({ organisation_id: organisationId, owner_user_account_id: ownerUserAccountId, name })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async addWidget(
    db: Kysely<Database>,
    organisationId: string,
    dashboardId: string,
    widgetKey: string,
    config: Record<string, unknown> = {},
    layout?: { x: number; y: number; w: number; h: number },
  ) {
    const widget = await db
      .selectFrom('widget_definitions')
      .selectAll()
      .where('widget_key', '=', widgetKey)
      .executeTakeFirst();
    if (!widget) throw new NotFoundException(`Widget "${widgetKey}" is not registered.`);
    return db
      .insertInto('dashboard_widgets')
      .values({
        organisation_id: organisationId,
        dashboard_id: dashboardId,
        widget_key: widgetKey,
        config: config as any,
        position_x: layout?.x ?? 0,
        position_y: layout?.y ?? 0,
        width: layout?.w ?? 4,
        height: layout?.h ?? 3,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async removeWidget(
    db: Kysely<Database>,
    organisationId: string,
    widgetInstanceId: string,
  ): Promise<void> {
    await db
      .deleteFrom('dashboard_widgets')
      .where('id', '=', widgetInstanceId)
      .where('organisation_id', '=', organisationId)
      .execute();
  }

  /**
   * Resolves a single widget's live data. PERMISSION SAFETY: if the
   * subject lacks permission on the widget's dataset, this throws
   * (ForbiddenException) - a dashboard NEVER silently shows an empty/zero
   * widget in place of a permission failure, which would risk leaking
   * "the aggregate is zero" as information about inaccessible data. The
   * caller (dashboard rendering) is expected to treat a widget it cannot
   * resolve as absent from the dashboard for that viewer, not as zero.
   */
  async resolveWidgetData(
    db: Kysely<Database>,
    subject: PermissionCheckSubject,
    widgetInstanceId: string,
  ): Promise<Record<string, unknown>[]> {
    const instance = await db
      .selectFrom('dashboard_widgets')
      .selectAll()
      .where('id', '=', widgetInstanceId)
      .where('organisation_id', '=', subject.organisationId)
      .executeTakeFirst();
    if (!instance) throw new NotFoundException('Widget instance not found.');
    const widget = await db
      .selectFrom('widget_definitions')
      .selectAll()
      .where('widget_key', '=', instance.widget_key)
      .executeTakeFirstOrThrow();

    const config = instance.config as Record<string, unknown>;
    return this.queryEngine.execute(db, subject, {
      datasetKey: widget.dataset_key,
      fields: config.fields as string[] | undefined,
      filters: config.filters as any,
      groupBy: config.groupBy as string[] | undefined,
      aggregations: config.aggregations as any,
      limit: (config.limit as number) ?? 50,
    });
  }

  async getDashboard(
    db: Kysely<Database>,
    organisationId: string,
    dashboardId: string,
    requestingUserAccountId: string,
  ) {
    const dashboard = await db
      .selectFrom('dashboards')
      .selectAll()
      .where('id', '=', dashboardId)
      .where('organisation_id', '=', organisationId)
      .executeTakeFirst();
    if (!dashboard) throw new NotFoundException('Dashboard not found.');
    if (
      dashboard.owner_user_account_id &&
      dashboard.owner_user_account_id !== requestingUserAccountId
    ) {
      throw new ForbiddenException('This dashboard belongs to another user.');
    }
    const widgets = await db
      .selectFrom('dashboard_widgets')
      .selectAll()
      .where('dashboard_id', '=', dashboardId)
      .execute();
    return { dashboard, widgets };
  }
}
