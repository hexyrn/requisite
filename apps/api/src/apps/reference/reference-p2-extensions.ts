import { Pool } from 'pg';
import { getPool } from '../../db/pool';
import { DatasetService } from '../../platform/reporting/dataset.service';
import { SavedReportService } from '../../platform/reporting/saved-report.service';
import { DashboardService } from '../../platform/dashboards/dashboard.service';
import { SearchService } from '../../platform/search/search.service';
import { ImportService } from '../../platform/import/import.service';
import { ImportHandlerRegistryService } from '../../platform/import/import-row-handler';
import { EventSchemaService } from '../../platform/events/event-schema.service';
import { withNoOrgContext } from '../../db/org-context';

const APP_ID = 'com.hexyrn.reference';

/**
 * P2 item 26 - Reference App Expansion. Registers com.hexyrn.reference
 * against every P2 extension point the same way registerReferenceApp
 * (P1) registered it against every P1 one: a reportable dataset + a
 * semantic relationship, a saved report template, a dashboard widget,
 * search participation, an import definition (with its row handler), and
 * an event payload schema for the event it already publishes
 * (reference.widget.approved) - proving each P2 mechanism actually works
 * end to end against a real, if small, application, not just in isolated
 * unit tests.
 */
export async function registerReferenceAppP2Extensions(
  datasets: DatasetService,
  savedReports: SavedReportService,
  dashboards: DashboardService,
  search: SearchService,
  imports: ImportService,
  importHandlers: ImportHandlerRegistryService,
  eventSchemas: EventSchemaService,
  pool: Pool = getPool(),
): Promise<void> {
  await datasets.registerDataset(
    {
      datasetKey: 'reference.widgets',
      appId: APP_ID,
      displayName: 'Reference Widgets',
      requiredPermission: 'reference.widget.view',
      sourceRef: 'reference_widgets',
      isExportable: true,
      fields: [
        { key: 'id', label: 'ID', fieldType: 'string', isDimension: true },
        {
          key: 'widget_number',
          label: 'Widget Number',
          fieldType: 'string',
          isDimension: true,
          filterable: true,
          sortable: true,
        },
        {
          key: 'title',
          label: 'Title',
          fieldType: 'string',
          isDimension: true,
          filterable: true,
          sortable: true,
          searchable: true,
        },
        {
          key: 'created_at',
          label: 'Created At',
          fieldType: 'string',
          isDimension: true,
          sortable: true,
        },
      ],
    },
    pool,
  );

  await datasets.registerDataset(
    {
      datasetKey: 'reference.widget_notes',
      appId: APP_ID,
      displayName: 'Reference Widget Notes',
      requiredPermission: 'reference.widget.view',
      sourceRef: 'reference_widget_notes',
      isExportable: true,
      fields: [
        { key: 'id', label: 'ID', fieldType: 'string', isDimension: true },
        { key: 'widget_id', label: 'Widget ID', fieldType: 'string', isDimension: true },
        { key: 'note_text', label: 'Note', fieldType: 'string', isDimension: true },
        {
          key: 'note_value',
          label: 'Value',
          fieldType: 'number',
          isMeasure: true,
          allowedAggregations: ['sum', 'avg', 'count', 'min', 'max'],
        },
      ],
    },
    pool,
  );

  await datasets.registerRelationship(
    'reference.widgets',
    'id',
    'reference.widget_notes',
    'widget_id',
    'one-to-many',
    'widget_notes',
    pool,
  );

  await withNoOrgContext(
    (db) =>
      savedReports.registerTemplate(
        'reference.widgets_by_status',
        APP_ID,
        'All Reference Widgets',
        'reference.widgets',
        {
          datasetKey: 'reference.widgets',
          fields: ['widget_number', 'title', 'created_at'],
          sort: [{ field: 'created_at', direction: 'desc' }],
        },
        db,
      ),
    pool,
  );

  await dashboards.registerWidget(
    {
      widgetKey: 'reference.widget-count-kpi',
      appId: APP_ID,
      displayName: 'Total Widgets',
      widgetType: 'kpi',
      datasetKey: 'reference.widgets',
      defaultConfig: { aggregations: [{ field: 'id', fn: 'count', alias: 'total' }] },
    },
    pool,
  );

  await withNoOrgContext(
    (db) =>
      search.registerEntityType(
        db,
        'reference.widget',
        APP_ID,
        'reference.widget.view',
        '{title}',
        '/reference/widgets/{id}',
      ),
    pool,
  );

  await withNoOrgContext(
    (db) =>
      imports.registerEntityType(db, 'reference.widget', APP_ID, 'reference.widget.create', [
        { key: 'title', label: 'Title', required: true, fieldType: 'string' },
        { key: 'widgetNumber', label: 'Widget Number', required: true, fieldType: 'string' },
      ]),
    pool,
  );
  importHandlers.register('reference.widget', async (db, organisationId, row) => {
    await db
      .insertInto('reference_widgets')
      .values({
        organisation_id: organisationId,
        widget_number: String(row.widgetNumber),
        title: String(row.title),
      })
      .execute();
  });

  await withNoOrgContext(
    (db) =>
      eventSchemas.registerSchema(db, 'reference.widget.approved', 1, APP_ID, {
        required: ['widgetId'],
        properties: { widgetId: 'string' },
      }),
    pool,
  );
}
