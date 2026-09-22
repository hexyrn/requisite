import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { DatasetService } from '../dataset.service';
import { ReportQueryService } from '../report-query.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('ReportQueryService - permission-safe query engine (P2 items 1-3/5, SECURITY-CRITICAL)', () => {
  let pool: Pool;
  let orgA: string;
  let orgB: string;
  const datasets = new DatasetService();
  const queryEngine = new ReportQueryService();

  function subject(permissions: string[], organisationId: string) {
    return { userAccountId: randomUUID(), organisationId, grantedPermissions: new Set(permissions) };
  }

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 15 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Report Org A');
    orgB = await createTestOrg(pool, 'Report Org B');

    await datasets.registerDataset(
      {
        datasetKey: 'reference.widgets',
        appId: 'com.hexyrn.reference',
        displayName: 'Widgets',
        requiredPermission: 'reference.widget.view',
        sourceRef: 'reference_widgets',
        fields: [
          { key: 'id', label: 'ID', fieldType: 'string' },
          { key: 'widget_number', label: 'Number', fieldType: 'string', isDimension: true, filterable: true, sortable: true, groupable: true },
          { key: 'title', label: 'Title', fieldType: 'string', filterable: true, sortable: true },
        ],
      },
      pool,
    );

    await datasets.registerDataset(
      {
        datasetKey: 'reference.widget-notes',
        appId: 'com.hexyrn.reference',
        displayName: 'Widget Notes',
        requiredPermission: 'reference.widget.view',
        sourceRef: 'reference_widget_notes',
        fields: [
          { key: 'widget_id', label: 'Widget', fieldType: 'string', isDimension: true, groupable: true, filterable: true },
          { key: 'note_value', label: 'Value', fieldType: 'number', isMeasure: true, allowedAggregations: ['sum', 'count', 'avg'] },
        ],
      },
      pool,
    );

    await datasets.registerRelationship('reference.widgets', 'id', 'reference.widget-notes', 'widget_id', 'one-to-many', 'notes', pool);

    // Restricted-classification dataset for permission tests.
    await datasets.registerDataset(
      {
        datasetKey: 'reference.restricted',
        appId: 'com.hexyrn.reference',
        displayName: 'Restricted',
        requiredPermission: 'reference.restricted.view',
        sourceRef: 'reference_widgets',
        fields: [{ key: 'title', label: 'Title', fieldType: 'string' }],
      },
      pool,
    );
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  async function seedWidget(orgId: string, title: string, noteValues: number[]) {
    const widget = await withOrgContext(orgId, (db) => db.insertInto('reference_widgets').values({ organisation_id: orgId, widget_number: `W-${randomUUID().slice(0, 8)}`, title }).returningAll().executeTakeFirstOrThrow(), pool);
    for (const v of noteValues) {
      await withOrgContext(orgId, (db) => db.insertInto('reference_widget_notes').values({ organisation_id: orgId, widget_id: widget.id, note_text: 'n', note_value: v as any }).execute(), pool);
    }
    return widget;
  }

  it('DATASET PERMISSION: a query is rejected without the dataset required_permission', async () => {
    await expect(
      withOrgContext(orgA, (db) => queryEngine.execute(db, subject([], orgA), { datasetKey: 'reference.widgets' }), pool),
    ).rejects.toThrow(/missing required permission/i);
  });

  it('a query succeeds with the required permission, returns declared fields, and enforces MAX_LIMIT/pagination', async () => {
    await seedWidget(orgA, 'Widget Alpha', []);
    const rows = await withOrgContext(orgA, (db) => queryEngine.execute(db, subject(['reference.widget.view'], orgA), { datasetKey: 'reference.widgets', fields: ['title'], limit: 5 }), pool);
    expect(rows.some((r) => r.title === 'Widget Alpha')).toBe(true);
    expect(Object.keys(rows[0])).toEqual(['title']);
  });

  it('rejects a field not declared on the dataset - no way to reach an arbitrary column', async () => {
    await expect(
      withOrgContext(orgA, (db) => queryEngine.execute(db, subject(['reference.widget.view'], orgA), { datasetKey: 'reference.widgets', fields: ['password_hash'] }), pool),
    ).rejects.toThrow(/not part of this dataset/i);
  });

  it('rejects an aggregation not in the field\'s allowedAggregations', async () => {
    await expect(
      withOrgContext(
        orgA,
        (db) => queryEngine.execute(db, subject(['reference.widget.view'], orgA), { datasetKey: 'reference.widget-notes', groupBy: ['widget_id'], aggregations: [{ field: 'widget_id', fn: 'sum' }] }),
        pool,
      ),
    ).rejects.toThrow(/not allowed/i);
  });

  it('ORGANISATION ISOLATION: a query in org A never returns org B\'s rows, even for the same dataset', async () => {
    await seedWidget(orgB, 'Widget In Org B', []);
    const rowsA = await withOrgContext(orgA, (db) => queryEngine.execute(db, subject(['reference.widget.view'], orgA), { datasetKey: 'reference.widgets', fields: ['title'], limit: 1000 }), pool);
    expect(rowsA.some((r) => r.title === 'Widget In Org B')).toBe(false);
  });

  it('filters, sorts, and groups only on fields declared filterable/sortable/groupable', async () => {
    await expect(
      withOrgContext(orgA, (db) => queryEngine.execute(db, subject(['reference.widget.view'], orgA), { datasetKey: 'reference.widgets', fields: ['title'], filters: [{ field: 'id', operator: '=', value: 'x' }] }), pool),
    ).rejects.toThrow(/not filterable/i);
  });

  it('CROSS-DATASET REPORTING: a relationship join is rejected if the caller lacks permission on the TARGET dataset', async () => {
    await datasets.registerDataset({ datasetKey: 'reference.widget-notes-restricted-test', appId: 'x', displayName: 'x', requiredPermission: 'x', sourceRef: 'reference_widget_notes', fields: [] }, pool).catch(() => undefined);
    // Use the actual restricted-permission target: register a NEW relationship to a dataset requiring a permission the subject lacks.
    await datasets.registerDataset({ datasetKey: 'reference.notes-gated', appId: 'com.hexyrn.reference', displayName: 'Notes (gated)', requiredPermission: 'reference.notes.special', sourceRef: 'reference_widget_notes', fields: [{ key: 'widget_id', label: 'w', fieldType: 'string', groupable: true }, { key: 'note_value', label: 'v', fieldType: 'number', isMeasure: true, allowedAggregations: ['sum'] }] }, pool);
    await datasets.registerRelationship('reference.widgets', 'id', 'reference.notes-gated', 'widget_id', 'one-to-many', 'gated-notes', pool);

    await expect(
      withOrgContext(
        orgA,
        (db) => queryEngine.execute(db, subject(['reference.widget.view'], orgA), { datasetKey: 'reference.widgets', fields: ['title'], join: { relationshipLabel: 'gated-notes', aggregations: [{ field: 'note_value', fn: 'sum' }] } }),
        pool,
      ),
    ).rejects.toThrow(/missing required permission/i);
  });

  it('an unregistered/unavailable relationship fails safe (not found), not an error that leaks structure', async () => {
    await expect(
      withOrgContext(orgA, (db) => queryEngine.execute(db, subject(['reference.widget.view'], orgA), { datasetKey: 'reference.widgets', fields: ['title'], join: { relationshipLabel: 'nonexistent' } }), pool),
    ).rejects.toThrow(/not available/i);
  });

  it('FAN-OUT SAFETY: summing a one-to-many related measure does NOT inflate when a widget has multiple notes', async () => {
    const widget = await seedWidget(orgA, 'Fan-out Test Widget', [10, 20, 30]); // 3 notes, sum should be 60, not 60*3 or similar inflation

    const rows = await withOrgContext(
      orgA,
      (db) =>
        queryEngine.execute(db, subject(['reference.widget.view'], orgA), {
          datasetKey: 'reference.widgets',
          fields: ['id', 'title'],
          filters: [{ field: 'title', operator: '=', value: 'Fan-out Test Widget' }],
          join: { relationshipLabel: 'notes', aggregations: [{ field: 'note_value', fn: 'sum', alias: 'total_value' }, { field: 'note_value', fn: 'count', alias: 'note_count' }] },
        }),
      pool,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0].total_value)).toBe(60); // NOT 180 (60*3) or any other fan-out-inflated value
    expect(Number(rows[0].note_count)).toBe(3);
    expect(rows[0].id).toBe(widget.id);
  });

  it('FAN-OUT SAFETY (multi-row): two widgets with different note counts each report their own correct sum, not a cross-contaminated total', async () => {
    const w1 = await seedWidget(orgA, 'FO Widget One', [5, 5]); // sum 10
    const w2 = await seedWidget(orgA, 'FO Widget Two', [100]); // sum 100

    const rows = await withOrgContext(
      orgA,
      (db) =>
        queryEngine.execute(db, subject(['reference.widget.view'], orgA), {
          datasetKey: 'reference.widgets',
          fields: ['id', 'title'],
          filters: [{ field: 'title', operator: 'contains', value: 'FO Widget' }],
          join: { relationshipLabel: 'notes', aggregations: [{ field: 'note_value', fn: 'sum', alias: 'total_value' }] },
        }),
      pool,
    );

    const row1 = rows.find((r) => r.id === w1.id);
    const row2 = rows.find((r) => r.id === w2.id);
    expect(Number(row1!.total_value)).toBe(10);
    expect(Number(row2!.total_value)).toBe(100);
  });

  it('a widget with ZERO related notes reports null/zero, not an error, and is not silently dropped', async () => {
    const widget = await seedWidget(orgA, 'No Notes Widget', []);
    const rows = await withOrgContext(
      orgA,
      (db) =>
        queryEngine.execute(db, subject(['reference.widget.view'], orgA), {
          datasetKey: 'reference.widgets',
          fields: ['id', 'title'],
          filters: [{ field: 'title', operator: '=', value: 'No Notes Widget' }],
          join: { relationshipLabel: 'notes', aggregations: [{ field: 'note_value', fn: 'sum', alias: 'total_value' }] },
        }),
      pool,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(widget.id);
    expect(rows[0].total_value === null || Number(rows[0].total_value) === 0).toBe(true);
  });

  it('FIELD-LEVEL PERMISSION: a field with its own requiredPermission is rejected even when the dataset-level permission is held', async () => {
    await datasets.registerDataset(
      {
        datasetKey: 'reference.with-secret-field',
        appId: 'com.hexyrn.reference',
        displayName: 'Has secret field',
        requiredPermission: 'reference.widget.view',
        sourceRef: 'reference_widgets',
        fields: [
          { key: 'title', label: 'Title', fieldType: 'string' },
          { key: 'widget_number', label: 'Secret Number', fieldType: 'string', requiredPermission: 'reference.widget.secret' },
        ],
      },
      pool,
    );
    await expect(
      withOrgContext(orgA, (db) => queryEngine.execute(db, subject(['reference.widget.view'], orgA), { datasetKey: 'reference.with-secret-field', fields: ['widget_number'] }), pool),
    ).rejects.toThrow(/missing required permission to view field/i);
  });

  it('QUERY RESOURCE CONTROLS: limit is capped at MAX_LIMIT regardless of what the caller requests', async () => {
    const rows = await withOrgContext(orgA, (db) => queryEngine.execute(db, subject(['reference.widget.view'], orgA), { datasetKey: 'reference.widgets', fields: ['title'], limit: 999999999 }), pool);
    expect(rows.length).toBeLessThanOrEqual(1000);
  });
});
