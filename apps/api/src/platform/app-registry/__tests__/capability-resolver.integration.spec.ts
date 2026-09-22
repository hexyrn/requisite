import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg, createTestLicense } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { ApplicationRegistryService } from '../application-registry.service';
import { CapabilityResolverService } from '../../capabilities/capability-resolver.service';
import { HexyrnAppManifest } from '@hexyrn/app-sdk';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const providerA: HexyrnAppManifest = {
  appId: 'com.hexyrn.provider-a',
  displayName: 'Provider A',
  version: '1.0.0',
  majorVersion: 1,
  requiresCoreVersion: '^0.1.0',
  capabilities: [
    { capability: 'purchasing.cost-source.v1', provides: { serviceRef: 'ProviderAService' } },
  ],
};

const providerB: HexyrnAppManifest = {
  appId: 'com.hexyrn.provider-b',
  displayName: 'Provider B',
  version: '1.0.0',
  majorVersion: 1,
  requiresCoreVersion: '^0.1.0',
  capabilities: [
    { capability: 'purchasing.cost-source.v1', provides: { serviceRef: 'ProviderBService' } },
  ],
};

describeIfDb('CapabilityResolverService (P1 item 3)', () => {
  let pool: Pool;
  let orgId: string;
  const registry = new ApplicationRegistryService();
  const resolver = new CapabilityResolverService(registry);

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgId = await createTestOrg(pool, 'Capability Test Org');
    await registry.registerApp(providerA, pool);
    await registry.registerApp(providerB, pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('ABSENT PROVIDER: resolving a capability nobody registered returns an empty list, not an error', async () => {
    const result = await withOrgContext(
      orgId,
      (db) => resolver.resolve(db, orgId, 'nonexistent.capability.v1'),
      pool,
    );
    expect(result).toEqual([]);
  });

  it('a registered but INACTIVE (not enabled) provider is excluded from resolution', async () => {
    const result = await withOrgContext(
      orgId,
      (db) => resolver.resolve(db, orgId, 'purchasing.cost-source.v1'),
      pool,
    );
    expect(result).toEqual([]); // neither provider enabled/licensed yet
  });

  it('MULTIPLE PROVIDERS: once both are active, resolve() returns both, not just one', async () => {
    for (const app of [providerA, providerB]) {
      await withOrgContext(orgId, (db) => registry.enableApp(db, orgId, app.appId), pool);
      const license = await createTestLicense(app.appId, orgId, app.majorVersion);
      await withOrgContext(
        orgId,
        (db) => registry.grantLicense(db, orgId, app.appId, app.majorVersion, license as any),
        pool,
      );
    }
    const result = await withOrgContext(
      orgId,
      (db) => resolver.resolve(db, orgId, 'purchasing.cost-source.v1'),
      pool,
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.appId).sort()).toEqual([providerA.appId, providerB.appId].sort());
  });

  it('ENABLED-APP AWARENESS: disabling one provider removes only that one from resolution', async () => {
    await withOrgContext(orgId, (db) => registry.disableApp(db, orgId, providerA.appId), pool);
    const result = await withOrgContext(
      orgId,
      (db) => resolver.resolve(db, orgId, 'purchasing.cost-source.v1'),
      pool,
    );
    expect(result).toHaveLength(1);
    expect(result[0].appId).toBe(providerB.appId);
  });

  it('capability resolution is per-organisation', async () => {
    const orgB = await createTestOrg(pool, 'Capability Org B');
    const result = await withOrgContext(
      orgB,
      (db) => resolver.resolve(db, orgB, 'purchasing.cost-source.v1'),
      pool,
    );
    expect(result).toEqual([]); // neither provider enabled for this org
  });
});
