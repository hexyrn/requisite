import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { ApplicationRegistryService } from '../application-registry.service';
import { HexyrnAppManifest } from '@hexyrn/app-sdk';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const manifest: HexyrnAppManifest = {
  appId: 'com.hexyrn.reference',
  displayName: 'Reference App',
  version: '1.0.0',
  majorVersion: 1,
  requiresCoreVersion: '^0.1.0',
  capabilities: [{ capability: 'reference.thing.v1', provides: { serviceRef: 'ReferenceThingService' } }],
};

const incompatibleManifest: HexyrnAppManifest = {
  appId: 'com.hexyrn.future-app',
  displayName: 'Future App',
  version: '1.0.0',
  majorVersion: 1,
  requiresCoreVersion: '^9.0.0',
};

describeIfDb('ApplicationRegistryService - installed/enabled/licensed/compatible (P1 item 1)', () => {
  let pool: Pool;
  let orgId: string;
  const registry = new ApplicationRegistryService();

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgId = await createTestOrg(pool, 'App Registry Test Org');
    await registry.registerApp(manifest, pool);
    await registry.registerApp(incompatibleManifest, pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('registerApp is idempotent - registering twice does not error or duplicate', async () => {
    await registry.registerApp(manifest, pool);
    const apps = await withOrgContext(orgId, (db) => registry.listInstalledApps(db), pool);
    expect(apps.filter((a) => a.app_id === manifest.appId)).toHaveLength(1);
  });

  it('a freshly-installed, never-enabled app is inactive', async () => {
    const state = await withOrgContext(orgId, (db) => registry.getApplicationState(db, orgId, manifest.appId), pool);
    expect(state).toEqual({ appId: manifest.appId, installed: true, enabled: false, licensed: false, compatible: true, active: false });
  });

  it('UNLICENSED APP ISOLATION: enabled but unlicensed remains inactive', async () => {
    await withOrgContext(orgId, (db) => registry.enableApp(db, orgId, manifest.appId), pool);
    const state = await withOrgContext(orgId, (db) => registry.getApplicationState(db, orgId, manifest.appId), pool);
    expect(state.enabled).toBe(true);
    expect(state.licensed).toBe(false);
    expect(state.active).toBe(false);
  });

  it('enabled + licensed + compatible => active', async () => {
    await withOrgContext(orgId, (db) => registry.grantLicense(db, orgId, manifest.appId, manifest.majorVersion, { signature: 'test-signature', issuedTo: orgId }), pool);
    const state = await withOrgContext(orgId, (db) => registry.getApplicationState(db, orgId, manifest.appId), pool);
    expect(state.active).toBe(true);
  });

  it('APP ACTIVATION/INACTIVITY: disabling an active app makes it inactive again, without losing its license', async () => {
    await withOrgContext(orgId, (db) => registry.disableApp(db, orgId, manifest.appId), pool);
    const state = await withOrgContext(orgId, (db) => registry.getApplicationState(db, orgId, manifest.appId), pool);
    expect(state.enabled).toBe(false);
    expect(state.licensed).toBe(true); // license untouched by disabling
    expect(state.active).toBe(false);

    // Re-enabling restores activity without re-licensing.
    await withOrgContext(orgId, (db) => registry.enableApp(db, orgId, manifest.appId), pool);
    const restored = await withOrgContext(orgId, (db) => registry.getApplicationState(db, orgId, manifest.appId), pool);
    expect(restored.active).toBe(true);
  });

  it('INCOMPATIBLE APP HANDLING: an app requiring a Core version this build cannot satisfy is never active, even enabled+licensed', async () => {
    await withOrgContext(orgId, (db) => registry.enableApp(db, orgId, incompatibleManifest.appId), pool);
    await withOrgContext(orgId, (db) => registry.grantLicense(db, orgId, incompatibleManifest.appId, incompatibleManifest.majorVersion, { signature: 'x' }), pool);
    const state = await withOrgContext(orgId, (db) => registry.getApplicationState(db, orgId, incompatibleManifest.appId), pool);
    expect(state.enabled).toBe(true);
    expect(state.licensed).toBe(true);
    expect(state.compatible).toBe(false);
    expect(state.active).toBe(false);
  });

  it('app state is per-organisation - enabling for one org does not enable for another', async () => {
    const orgB = await createTestOrg(pool, 'Org B');
    const stateB = await withOrgContext(orgB, (db) => registry.getApplicationState(db, orgB, manifest.appId), pool);
    expect(stateB.enabled).toBe(false);
    expect(stateB.active).toBe(false);
  });
});
