import { Pool } from 'pg';
import { getPool } from '../../db/pool';
import { withNoOrgContext } from '../../db/org-context';
import { DatasetService } from '../../platform/reporting/dataset.service';
import { SavedReportService } from '../../platform/reporting/saved-report.service';
import { DashboardService } from '../../platform/dashboards/dashboard.service';
import { SearchService } from '../../platform/search/search.service';
import { ImportService } from '../../platform/import/import.service';
import { ImportHandlerRegistryService } from '../../platform/import/import-row-handler';
import { REQUISITE_APP_MANIFEST } from './requisite.manifest';

const APP_ID = REQUISITE_APP_MANIFEST.appId;

/**
 * Item 24-29 - registers com.hexyrn.requisite against Core's reporting/
 * dashboard/search/import infrastructure, exactly the same pattern
 * reference-p2-extensions.ts established for the reference app. Semantic
 * datasets, not raw tables (item 24): field visibility/permission is
 * declared once here and enforced identically by ReportQueryService for
 * every report/dashboard/export built on top.
 */
export async function registerRequisiteP2Extensions(
  datasets: DatasetService,
  savedReports: SavedReportService,
  dashboards: DashboardService,
  search: SearchService,
  imports: ImportService,
  importHandlers: ImportHandlerRegistryService,
  pool: Pool = getPool(),
): Promise<void> {
  await datasets.registerDataset(
    {
      datasetKey: 'requisite.suppliers',
      appId: APP_ID,
      displayName: 'Suppliers',
      requiredPermission: 'requisite.suppliers.view',
      sourceRef: 'requisite_suppliers',
      isExportable: true,
      fields: [
        { key: 'id', label: 'ID', fieldType: 'string', isDimension: true },
        { key: 'supplier_number', label: 'Supplier Number', fieldType: 'string', isDimension: true, filterable: true, sortable: true },
        { key: 'name', label: 'Name', fieldType: 'string', isDimension: true, filterable: true, sortable: true, searchable: true },
        { key: 'status', label: 'Status', fieldType: 'string', isDimension: true, filterable: true, groupable: true },
        { key: 'default_currency', label: 'Currency', fieldType: 'string', isDimension: true, filterable: true },
      ],
    },
    pool,
  );

  await datasets.registerDataset(
    {
      datasetKey: 'requisite.requisitions',
      appId: APP_ID,
      displayName: 'Requisitions',
      requiredPermission: 'requisite.requisitions.view',
      sourceRef: 'requisite_requisitions',
      isExportable: true,
      fields: [
        { key: 'id', label: 'ID', fieldType: 'string', isDimension: true },
        { key: 'requisition_number', label: 'Requisition Number', fieldType: 'string', isDimension: true, filterable: true, sortable: true },
        { key: 'status', label: 'Status', fieldType: 'string', isDimension: true, filterable: true, groupable: true, sortable: true },
        { key: 'category', label: 'Category', fieldType: 'string', isDimension: true, filterable: true, groupable: true },
        { key: 'cost_object_reference', label: 'Project/Cost Reference', fieldType: 'string', isDimension: true, filterable: true, groupable: true },
        { key: 'currency', label: 'Currency', fieldType: 'string', isDimension: true, filterable: true },
        { key: 'estimated_value_minor', label: 'Estimated Value (minor units)', fieldType: 'number', isMeasure: true, allowedAggregations: ['sum', 'avg', 'count', 'min', 'max'] },
        { key: 'organisational_unit_id', label: 'Org Unit', fieldType: 'string', isDimension: true, filterable: true, groupable: true },
        { key: 'requester_user_account_id', label: 'Requester', fieldType: 'string', isDimension: true, filterable: true, groupable: true },
        { key: 'created_at', label: 'Created At', fieldType: 'string', isDimension: true, sortable: true },
      ],
    },
    pool,
  );

  await datasets.registerDataset(
    {
      datasetKey: 'requisite.purchase_orders',
      appId: APP_ID,
      displayName: 'Purchase Orders',
      requiredPermission: 'requisite.purchase-orders.view',
      sourceRef: 'requisite_purchase_orders',
      isExportable: true,
      fields: [
        { key: 'id', label: 'ID', fieldType: 'string', isDimension: true },
        { key: 'po_number', label: 'PO Number', fieldType: 'string', isDimension: true, filterable: true, sortable: true },
        { key: 'status', label: 'Status', fieldType: 'string', isDimension: true, filterable: true, groupable: true, sortable: true },
        { key: 'supplier_id', label: 'Supplier', fieldType: 'string', isDimension: true, filterable: true, groupable: true },
        { key: 'currency', label: 'Currency', fieldType: 'string', isDimension: true, filterable: true },
        { key: 'subtotal_minor', label: 'Subtotal (minor units)', fieldType: 'number', isMeasure: true, allowedAggregations: ['sum', 'avg', 'count'] },
        { key: 'tax_minor', label: 'Tax (minor units)', fieldType: 'number', isMeasure: true, allowedAggregations: ['sum', 'avg'] },
        { key: 'total_minor', label: 'Total (minor units)', fieldType: 'number', isMeasure: true, allowedAggregations: ['sum', 'avg', 'count', 'min', 'max'] },
        { key: 'expected_delivery_date', label: 'Expected Delivery', fieldType: 'string', isDimension: true, filterable: true, sortable: true },
        { key: 'organisational_unit_id', label: 'Org Unit', fieldType: 'string', isDimension: true, filterable: true, groupable: true },
        { key: 'order_date', label: 'Order Date', fieldType: 'string', isDimension: true, sortable: true },
      ],
    },
    pool,
  );

  await datasets.registerDataset(
    {
      datasetKey: 'requisite.goods_receipts',
      appId: APP_ID,
      displayName: 'Goods Receipts',
      requiredPermission: 'requisite.goods-receipts.view',
      sourceRef: 'requisite_goods_receipts',
      isExportable: true,
      fields: [
        { key: 'id', label: 'ID', fieldType: 'string', isDimension: true },
        { key: 'grn_number', label: 'GRN Number', fieldType: 'string', isDimension: true, filterable: true, sortable: true },
        { key: 'purchase_order_id', label: 'Purchase Order', fieldType: 'string', isDimension: true, filterable: true, groupable: true },
        { key: 'received_at', label: 'Received At', fieldType: 'string', isDimension: true, sortable: true },
        { key: 'delivery_note_reference', label: 'Delivery Note Ref', fieldType: 'string', isDimension: true, filterable: true },
      ],
    },
    pool,
  );

  // Semantic relationships (item 24): PO -> Supplier, PO -> Requisition -
  // reusing the exact fan-out-safe relationship machinery items 2/3/5
  // proved in Core P2.
  await datasets.registerRelationship('requisite.purchase_orders', 'supplier_id', 'requisite.suppliers', 'id', 'many-to-one', 'supplier', pool);
  await datasets.registerRelationship('requisite.purchase_orders', 'source_requisition_id', 'requisite.requisitions', 'id', 'many-to-one', 'source_requisition', pool);
  await datasets.registerRelationship('requisite.goods_receipts', 'purchase_order_id', 'requisite.purchase_orders', 'id', 'many-to-one', 'purchase_order', pool);

  // Built-in reports (item 25) - a representative starter set; customers
  // clone/customise through Core's normal saved-report mechanism.
  await withNoOrgContext(
    (db) => savedReports.registerTemplate('requisite.open_purchase_orders', APP_ID, 'Open Purchase Orders', 'requisite.purchase_orders', { datasetKey: 'requisite.purchase_orders', fields: ['po_number', 'status', 'supplier_id', 'total_minor', 'expected_delivery_date'], filters: [{ field: 'status', operator: '!=', value: 'completed' }], sort: [{ field: 'expected_delivery_date', direction: 'asc' }] }, db),
    pool,
  );
  await withNoOrgContext(
    (db) => savedReports.registerTemplate('requisite.purchasing_by_supplier', APP_ID, 'Purchasing by Supplier', 'requisite.purchase_orders', { datasetKey: 'requisite.purchase_orders', groupBy: ['supplier_id'], aggregations: [{ field: 'total_minor', fn: 'sum', alias: 'total_spend' }, { field: 'id', fn: 'count', alias: 'order_count' }] }, db),
    pool,
  );

  // Dashboard widgets (item 26).
  await dashboards.registerWidget({ widgetKey: 'requisite.open-pos-kpi', appId: APP_ID, displayName: 'Open Purchase Orders', widgetType: 'kpi', datasetKey: 'requisite.purchase_orders', defaultConfig: { filters: [{ field: 'status', operator: '!=', value: 'completed' }], aggregations: [{ field: 'id', fn: 'count', alias: 'total' }] } }, pool);
  await dashboards.registerWidget({ widgetKey: 'requisite.spend-by-supplier', appId: APP_ID, displayName: 'Spend by Supplier', widgetType: 'bar_chart', datasetKey: 'requisite.purchase_orders', defaultConfig: { groupBy: ['supplier_id'], aggregations: [{ field: 'total_minor', fn: 'sum', alias: 'spend' }] } }, pool);

  // Search participation (item 28).
  await withNoOrgContext((db) => search.registerEntityType(db, 'requisite.supplier', APP_ID, 'requisite.suppliers.view', '{name}', '/requisite/suppliers/{id}'), pool);
  await withNoOrgContext((db) => search.registerEntityType(db, 'requisite.requisition', APP_ID, 'requisite.requisitions.view', '{requisition_number}', '/requisite/requisitions/{id}'), pool);
  await withNoOrgContext((db) => search.registerEntityType(db, 'requisite.purchase_order', APP_ID, 'requisite.purchase-orders.view', '{po_number}', '/requisite/purchase-orders/{id}'), pool);

  // Import framework (item 29) - supplier import, with row-level errors
  // rather than silent duplicate-supplier creation: the handler treats a
  // matching supplier_number as an update, never a blind insert.
  await withNoOrgContext(
    (db) =>
      imports.registerEntityType(db, 'requisite.supplier', APP_ID, 'requisite.suppliers.manage', [
        { key: 'name', label: 'Name', required: true, fieldType: 'string' },
        { key: 'supplierNumber', label: 'Supplier Number', required: true, fieldType: 'string' },
        { key: 'email', label: 'Email', fieldType: 'string' },
        { key: 'phone', label: 'Phone', fieldType: 'string' },
      ]),
    pool,
  );
  importHandlers.register('requisite.supplier', async (db, organisationId, row) => {
    const existing = await db.selectFrom('requisite_suppliers').select('id').where('organisation_id', '=', organisationId).where('supplier_number', '=', String(row.supplierNumber)).executeTakeFirst();
    if (existing) {
      // Explicit duplicate-handling strategy: update the existing supplier
      // rather than silently creating a second one with the same number
      // (item 29's "no silent duplicate supplier creation").
      await db.updateTable('requisite_suppliers').set({ name: String(row.name), email: row.email ? String(row.email) : null, phone: row.phone ? String(row.phone) : null, updated_at: new Date() as any }).where('id', '=', existing.id).execute();
      return;
    }
    await db.insertInto('requisite_suppliers').values({ organisation_id: organisationId, supplier_number: String(row.supplierNumber), name: String(row.name), email: row.email ? String(row.email) : null, phone: row.phone ? String(row.phone) : null }).execute();
  });
}
