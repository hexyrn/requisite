import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { ConnectorRegistryService } from '../connector-registry.service';
import { IntegrationConnectionService } from '../integration-connection.service';
import { SyncAdapterRegistryService } from '../sync-adapter-registry.service';
import { SyncHandlerRegistryService } from '../sync-row-handler';
import { SyncEngineService } from '../sync-engine.service';
import { registerReferenceConnector, REFERENCE_CONNECTOR_ID, ReferenceConnectorAdapter } from '../../../apps/reference/reference-connector';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Integration Framework + Sync Engine, via the Reference Connector (P2 items 16-20/27)', () => {
  let pool: Pool;
  let orgA: string;
  const connectorRegistry = new ConnectorRegistryService();
  const connections = new IntegrationConnectionService();
  const adapters = new SyncAdapterRegistryService();
  const syncHandlers = new SyncHandlerRegistryService();
  const syncEngine = new SyncEngineService(connections, adapters, syncHandlers);
  let referenceAdapter: ReferenceConnectorAdapter;

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Integration Org A');
    referenceAdapter = await registerReferenceConnector(connectorRegistry, adapters, syncHandlers, pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('creates a connection with encrypted secrets that never appear in plaintext at rest', async () => {
    const connection = await withOrgContext(orgA, (db) => connections.createConnection(db, orgA, REFERENCE_CONNECTOR_ID, 'My Reference Instance', { baseUrl: 'https://example.com' }, { apiToken: 'super-secret-token-value' }), pool);
    expect(JSON.stringify(connection.config_secrets_encrypted)).not.toContain('super-secret-token-value');

    const decrypted = await withOrgContext(orgA, (db) => connections.getDecryptedSecrets(db, orgA, connection.id), pool);
    expect(decrypted.apiToken).toBe('super-secret-token-value');
  });

  it('rejects an unknown connector id', async () => {
    await expect(withOrgContext(orgA, (db) => connections.createConnection(db, orgA, 'not.a.real.connector', 'X', {}, {}), pool)).rejects.toThrow(/not registered/i);
  });

  it('rejects a bidirectional ownership without a conflict resolution strategy', async () => {
    const connection = await withOrgContext(orgA, (db) => connections.createConnection(db, orgA, REFERENCE_CONNECTOR_ID, 'Conn2', {}, {}), pool);
    await expect(withOrgContext(orgA, (db) => connections.setOwnership(db, orgA, connection.id, 'reference.widget', 'bidirectional', 'external'), pool)).rejects.toThrow(/conflictResolution/i);
  });

  it('rejects an unknown field transform', async () => {
    const connection = await withOrgContext(orgA, (db) => connections.createConnection(db, orgA, REFERENCE_CONNECTOR_ID, 'Conn3', {}, {}), pool);
    await expect(withOrgContext(orgA, (db) => connections.setFieldMapping(db, orgA, connection.id, 'reference.widget', [{ hexyrnField: 'title', externalField: 'name', transform: 'exec_shell_command' }]), pool)).rejects.toThrow(/Unknown transform/i);
  });

  it('END TO END: runs a sync that creates widgets from external records, applying field mapping transforms', async () => {
    const connection = await withOrgContext(orgA, (db) => connections.createConnection(db, orgA, REFERENCE_CONNECTOR_ID, 'E2E Conn', {}, { apiToken: 'tok' }), pool);
    await withOrgContext(orgA, (db) => connections.setOwnership(db, orgA, connection.id, 'reference.widget', 'external_to_hexyrn', 'external'), pool);
    await withOrgContext(orgA, (db) => connections.setFieldMapping(db, orgA, connection.id, 'reference.widget', [
      { hexyrnField: 'title', externalField: 'name', transform: 'trim' },
      { hexyrnField: 'widgetNumber', externalField: 'sku', required: true },
    ]), pool);

    referenceAdapter.setFixtureRecords([
      { externalId: 'ext-1', fields: { name: '  Widget One  ', sku: 'SKU-1' } },
      { externalId: 'ext-2', fields: { name: 'Widget Two', sku: 'SKU-2' } },
    ]);

    const result = await withOrgContext(orgA, (db) => syncEngine.runSync(db, orgA, connection.id, 'reference.widget'), pool);
    expect(result.processedCount).toBe(2);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);

    const widget = await withOrgContext(orgA, (db) => db.selectFrom('reference_widgets').selectAll().where('widget_number', '=', 'SKU-1').executeTakeFirstOrThrow(), pool);
    expect(widget.title).toBe('Widget One'); // trimmed

    const mapping = await withOrgContext(orgA, (db) => db.selectFrom('sync_external_ids').selectAll().where('external_id', '=', 'ext-1').executeTakeFirstOrThrow(), pool);
    expect(mapping.hexyrn_entity_id).toBe(widget.id);
  });

  it('IDEMPOTENCY: re-running the sync with the same external ids updates the existing widgets rather than duplicating them', async () => {
    const connection = await withOrgContext(orgA, (db) => connections.createConnection(db, orgA, REFERENCE_CONNECTOR_ID, 'Idempotency Conn', {}, { apiToken: 'tok' }), pool);
    await withOrgContext(orgA, (db) => connections.setOwnership(db, orgA, connection.id, 'reference.widget', 'external_to_hexyrn', 'external'), pool);
    await withOrgContext(orgA, (db) => connections.setFieldMapping(db, orgA, connection.id, 'reference.widget', [
      { hexyrnField: 'title', externalField: 'name' },
      { hexyrnField: 'widgetNumber', externalField: 'sku', required: true },
    ]), pool);

    referenceAdapter.setFixtureRecords([{ externalId: 'idem-1', fields: { name: 'Original Title', sku: 'IDEM-SKU' } }]);
    await withOrgContext(orgA, (db) => syncEngine.runSync(db, orgA, connection.id, 'reference.widget'), pool);
    const firstCount = await withOrgContext(orgA, (db) => db.selectFrom('reference_widgets').select((eb) => eb.fn.countAll().as('c')).where('widget_number', '=', 'IDEM-SKU').executeTakeFirstOrThrow(), pool);
    expect(Number(firstCount.c)).toBe(1);

    referenceAdapter.setFixtureRecords([{ externalId: 'idem-1', fields: { name: 'Updated Title', sku: 'IDEM-SKU' } }]);
    await withOrgContext(orgA, (db) => syncEngine.runSync(db, orgA, connection.id, 'reference.widget'), pool);

    const secondCount = await withOrgContext(orgA, (db) => db.selectFrom('reference_widgets').select((eb) => eb.fn.countAll().as('c')).where('widget_number', '=', 'IDEM-SKU').executeTakeFirstOrThrow(), pool);
    expect(Number(secondCount.c)).toBe(1); // still exactly one row, not two

    const updatedWidget = await withOrgContext(orgA, (db) => db.selectFrom('reference_widgets').selectAll().where('widget_number', '=', 'IDEM-SKU').executeTakeFirstOrThrow(), pool);
    expect(updatedWidget.title).toBe('Updated Title');
  });

  it('records a per-record failure without aborting the whole sync run', async () => {
    const connection = await withOrgContext(orgA, (db) => connections.createConnection(db, orgA, REFERENCE_CONNECTOR_ID, 'Failure Conn', {}, { apiToken: 'tok' }), pool);
    await withOrgContext(orgA, (db) => connections.setOwnership(db, orgA, connection.id, 'reference.widget', 'external_to_hexyrn', 'external'), pool);
    await withOrgContext(orgA, (db) => connections.setFieldMapping(db, orgA, connection.id, 'reference.widget', [
      { hexyrnField: 'title', externalField: 'name' },
      { hexyrnField: 'widgetNumber', externalField: 'sku', required: true },
    ]), pool);

    referenceAdapter.setFixtureRecords([
      { externalId: 'good-1', fields: { name: 'Fine', sku: 'GOOD-SKU' } },
      { externalId: 'bad-1', fields: { name: 'Missing SKU' } }, // sku missing -> required field failure
    ]);

    const result = await withOrgContext(orgA, (db) => syncEngine.runSync(db, orgA, connection.id, 'reference.widget'), pool);
    expect(result.processedCount).toBe(2);
    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);

    const run = await withOrgContext(orgA, (db) => db.selectFrom('sync_runs').selectAll().where('id', '=', result.runId).executeTakeFirstOrThrow(), pool);
    expect((run.errors as any[])[0].externalId).toBe('bad-1');
  });

  it('rejects a sync with no ownership configured for the entity type', async () => {
    const connection = await withOrgContext(orgA, (db) => connections.createConnection(db, orgA, REFERENCE_CONNECTOR_ID, 'No Ownership Conn', {}, { apiToken: 'tok' }), pool);
    await expect(withOrgContext(orgA, (db) => syncEngine.runSync(db, orgA, connection.id, 'reference.widget'), pool)).rejects.toThrow(/no sync ownership/i);
  });
});
