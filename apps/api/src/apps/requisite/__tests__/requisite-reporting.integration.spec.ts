import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { DatasetService } from '../../../platform/reporting/dataset.service';
import { ReportQueryService } from '../../../platform/reporting/report-query.service';
import { SavedReportService } from '../../../platform/reporting/saved-report.service';
import { DashboardService } from '../../../platform/dashboards/dashboard.service';
import { SearchService } from '../../../platform/search/search.service';
import { ImportService } from '../../../platform/import/import.service';
import { ImportHandlerRegistryService } from '../../../platform/import/import-row-handler';
import { registerRequisiteP2Extensions } from '../requisite-p2-extensions';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Requisite P2 integrations - reporting/dashboards/search/import (items 24-29)', () => {
  let pool: Pool;
  let orgA: string;
  const datasets = new DatasetService();
  const queryEngine = new ReportQueryService();
  const savedReports = new SavedReportService();
  const dashboards = new DashboardService(queryEngine);
  const search = new SearchService();
  const importHandlers = new ImportHandlerRegistryService();
  const imports = new ImportService(importHandlers);

  let testUserId: string;

  function subject(permissions: string[], organisationId: string) {
    return { userAccountId: testUserId, organisationId, grantedPermissions: new Set(permissions) };
  }

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Requisite Reporting Org A');
    await registerRequisiteP2Extensions(
      datasets,
      savedReports,
      dashboards,
      search,
      imports,
      importHandlers,
      pool,
    );
    testUserId = await withOrgContext(
      orgA,
      (db) =>
        db
          .insertInto('user_accounts')
          .values({
            organisation_id: orgA,
            email: `req-report-${randomUUID()}@example.com`,
            password_hash: 'x',
            is_active: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      pool,
    ).then((r) => r.id);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('REPORTING: registers requisite.suppliers/requisitions/purchase_orders/goods_receipts as permission-safe datasets', async () => {
    const dsRows = await withOrgContext(
      orgA,
      (db) =>
        db
          .selectFrom('dataset_definitions')
          .selectAll()
          .where('app_id', '=', 'com.hexyrn.requisite')
          .execute(),
      pool,
    );
    const keys = dsRows.map((d) => d.dataset_key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'requisite.suppliers',
        'requisite.requisitions',
        'requisite.purchase_orders',
        'requisite.goods_receipts',
      ]),
    );
  });

  it('REPORTING: purchasing spend can be queried and aggregated respecting the dataset permission', async () => {
    await withOrgContext(
      orgA,
      (db) =>
        db
          .insertInto('requisite_suppliers')
          .values({
            organisation_id: orgA,
            supplier_number: 'SUP-00001',
            name: 'Report Test Supplier',
          })
          .execute(),
      pool,
    );
    const supplier = await withOrgContext(
      orgA,
      (db) => db.selectFrom('requisite_suppliers').selectAll().executeTakeFirstOrThrow(),
      pool,
    );
    await withOrgContext(
      orgA,
      (db) =>
        db
          .insertInto('requisite_purchase_orders')
          .values({
            organisation_id: orgA,
            po_number: 'PO-00001',
            supplier_id: supplier.id,
            total_minor: '50000',
            status: 'issued',
          })
          .execute(),
      pool,
    );
    await withOrgContext(
      orgA,
      (db) =>
        db
          .insertInto('requisite_purchase_orders')
          .values({
            organisation_id: orgA,
            po_number: 'PO-00002',
            supplier_id: supplier.id,
            total_minor: '30000',
            status: 'issued',
          })
          .execute(),
      pool,
    );

    const rows = await withOrgContext(
      orgA,
      (db) =>
        queryEngine.execute(db, subject(['requisite.purchase-orders.view'], orgA), {
          datasetKey: 'requisite.purchase_orders',
          groupBy: ['supplier_id'],
          aggregations: [{ field: 'total_minor', fn: 'sum', alias: 'total_spend' }],
        }),
      pool,
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_spend)).toBe(80000);
  });

  it('REPORTING PERMISSION SAFETY: a subject without requisite.purchase-orders.view cannot query the dataset', async () => {
    await expect(
      withOrgContext(
        orgA,
        (db) =>
          queryEngine.execute(db, subject([], orgA), { datasetKey: 'requisite.purchase_orders' }),
        pool,
      ),
    ).rejects.toThrow(/missing required permission/i);
  });

  it('REPORTING: PO -> Supplier relationship is registered and traversable', async () => {
    const relationship = await withOrgContext(
      orgA,
      (db) =>
        db
          .selectFrom('dataset_relationships')
          .selectAll()
          .where('label', '=', 'supplier')
          .executeTakeFirst(),
      pool,
    );
    expect(relationship).toBeTruthy();
  });

  it('DASHBOARDS: registers a KPI widget backed by the purchase orders dataset', async () => {
    const widget = await withOrgContext(
      orgA,
      (db) =>
        db
          .selectFrom('widget_definitions')
          .selectAll()
          .where('widget_key', '=', 'requisite.open-pos-kpi')
          .executeTakeFirst(),
      pool,
    );
    expect(widget).toBeTruthy();
    expect(widget!.dataset_key).toBe('requisite.purchase_orders');
  });

  it('SEARCH: an indexed supplier is found by name, respecting the required permission', async () => {
    const supplierId = randomUUID();
    await withOrgContext(
      orgA,
      (db) =>
        search.indexUpsert(
          db,
          orgA,
          'requisite.supplier',
          supplierId,
          'Titanium Bolt Supply Co',
          'Titanium Bolt Supply Co',
          `/requisite/suppliers/${supplierId}`,
        ),
      pool,
    );
    const results = await withOrgContext(
      orgA,
      (db) => search.search(db, subject(['requisite.suppliers.view'], orgA), 'titanium'),
      pool,
    );
    expect(results.some((r) => r.entityId === supplierId)).toBe(true);

    const noPermResults = await withOrgContext(
      orgA,
      (db) => search.search(db, subject([], orgA), 'titanium'),
      pool,
    );
    expect(noPermResults).toHaveLength(0);
  });

  it('IMPORT: supplier import updates an existing supplier by supplier_number instead of creating a duplicate', async () => {
    await withOrgContext(
      orgA,
      (db) =>
        db
          .insertInto('requisite_suppliers')
          .values({ organisation_id: orgA, supplier_number: 'SUP-IMPORT-1', name: 'Original Name' })
          .execute(),
      pool,
    );
    const rows = [{ Name: 'Updated Name via Import', SupplierNumber: 'SUP-IMPORT-1' }];
    const result = await withOrgContext(
      orgA,
      (db) =>
        imports.runImport(
          db,
          subject(['requisite.suppliers.manage'], orgA),
          'requisite.supplier',
          rows,
          { name: 'Name', supplierNumber: 'SupplierNumber' },
        ),
      pool,
    );
    expect(result.successCount).toBe(1);

    const allSuppliers = await withOrgContext(
      orgA,
      (db) =>
        db
          .selectFrom('requisite_suppliers')
          .selectAll()
          .where('supplier_number', '=', 'SUP-IMPORT-1')
          .execute(),
      pool,
    );
    expect(allSuppliers).toHaveLength(1); // no duplicate created
    expect(allSuppliers[0].name).toBe('Updated Name via Import');
  });

  it('IMPORT: a brand-new supplier_number creates a new supplier', async () => {
    const rows = [{ Name: 'Brand New Supplier', SupplierNumber: 'SUP-IMPORT-NEW' }];
    await withOrgContext(
      orgA,
      (db) =>
        imports.runImport(
          db,
          subject(['requisite.suppliers.manage'], orgA),
          'requisite.supplier',
          rows,
          { name: 'Name', supplierNumber: 'SupplierNumber' },
        ),
      pool,
    );
    const created = await withOrgContext(
      orgA,
      (db) =>
        db
          .selectFrom('requisite_suppliers')
          .selectAll()
          .where('supplier_number', '=', 'SUP-IMPORT-NEW')
          .executeTakeFirst(),
      pool,
    );
    expect(created).toBeTruthy();
  });
});
