import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { DatasetService } from '../../reporting/dataset.service';
import { ReportQueryService } from '../../reporting/report-query.service';
import { DashboardService } from '../dashboard.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('DashboardService - widgets over the permission-aware query path (P2 item 6)', () => {
  let pool: Pool;
  let orgA: string;
  let orgB: string;
  const datasets = new DatasetService();
  const queryEngine = new ReportQueryService();
  const dashboards = new DashboardService(queryEngine);

  function subject(permissions: string[], organisationId: string, userAccountId = randomUUID()) {
    return { userAccountId, organisationId, grantedPermissions: new Set(permissions) };
  }

  async function makeUser(organisationId: string, email: string): Promise<string> {
    const row = await withOrgContext(
      organisationId,
      (db) => db.insertInto('user_accounts').values({ organisation_id: organisationId, email, password_hash: 'x', is_active: true }).returningAll().executeTakeFirstOrThrow(),
      pool,
    );
    return row.id;
  }

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Dashboard Org A');
    orgB = await createTestOrg(pool, 'Dashboard Org B');

    await datasets.registerDataset(
      { datasetKey: 'reference.widgets', appId: 'com.hexyrn.reference', displayName: 'Widgets', requiredPermission: 'reference.widget.view', sourceRef: 'reference_widgets', fields: [{ key: 'id', label: 'ID', fieldType: 'string', isMeasure: true, allowedAggregations: ['count'] }] },
      pool,
    );
    await dashboards.registerWidget({ widgetKey: 'reference.widget-count', appId: 'com.hexyrn.reference', displayName: 'Widget Count', widgetType: 'kpi', datasetKey: 'reference.widgets' }, pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('creates a dashboard, adds a widget, and resolves its data through the query engine', async () => {
    await withOrgContext(orgA, (db) => db.insertInto('reference_widgets').values({ organisation_id: orgA, widget_number: 'W-1', title: 'A' }).execute(), pool);
    const owner = await makeUser(orgA, `owner1-${randomUUID()}@example.com`);
    const result = await withOrgContext(
      orgA,
      async (db) => {
        const dashboard = await dashboards.createDashboard(db, orgA, owner, 'My Dashboard');
        const widget = await dashboards.addWidget(db, orgA, dashboard.id, 'reference.widget-count', { aggregations: [{ field: 'id', fn: 'count', alias: 'total' }] });
        return dashboards.resolveWidgetData(db, subject(['reference.widget.view'], orgA), widget.id);
      },
      pool,
    );
    expect(Number(result[0].total)).toBeGreaterThanOrEqual(1);
  });

  it('WIDGET PERMISSIONS: resolving a widget without the dataset permission throws, never returns zero/empty as a silent substitute', async () => {
    const owner = await makeUser(orgA, `owner2-${randomUUID()}@example.com`);
    await expect(
      withOrgContext(
        orgA,
        async (db) => {
          const dashboard = await dashboards.createDashboard(db, orgA, owner, 'D2');
          const widget = await dashboards.addWidget(db, orgA, dashboard.id, 'reference.widget-count', {});
          return dashboards.resolveWidgetData(db, subject([], orgA), widget.id);
        },
        pool,
      ),
    ).rejects.toThrow(/missing required permission/i);
  });

  it('ORGANISATION ISOLATION: a widget instance from org A is not visible/resolvable from org B context', async () => {
    const owner = await makeUser(orgA, `owner3-${randomUUID()}@example.com`);
    const widgetId = await withOrgContext(
      orgA,
      async (db) => {
        const dashboard = await dashboards.createDashboard(db, orgA, owner, 'D3');
        const widget = await dashboards.addWidget(db, orgA, dashboard.id, 'reference.widget-count', {});
        return widget.id;
      },
      pool,
    );
    await expect(withOrgContext(orgB, (db) => dashboards.resolveWidgetData(db, subject(['reference.widget.view'], orgB), widgetId), pool)).rejects.toThrow(/not found/i);
  });

  it('a dashboard belonging to another user cannot be fetched (dashboard ownership)', async () => {
    const owner1 = await makeUser(orgA, `owner4a-${randomUUID()}@example.com`);
    const owner2 = await makeUser(orgA, `owner4b-${randomUUID()}@example.com`);
    const dashboardId = await withOrgContext(orgA, (db) => dashboards.createDashboard(db, orgA, owner1, 'Private'), pool).then((d) => d.id);
    await expect(withOrgContext(orgA, (db) => dashboards.getDashboard(db, orgA, dashboardId, owner2), pool)).rejects.toThrow(/belongs to another user/i);
  });

  it('adding a widget with an unregistered widgetKey fails', async () => {
    const owner = await makeUser(orgA, `owner5-${randomUUID()}@example.com`);
    await expect(
      withOrgContext(
        orgA,
        async (db) => {
          const dashboard = await dashboards.createDashboard(db, orgA, owner, 'D4');
          return dashboards.addWidget(db, orgA, dashboard.id, 'nonexistent.widget', {});
        },
        pool,
      ),
    ).rejects.toThrow(/not registered/i);
  });
});
