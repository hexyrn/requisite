import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { TerminologyService } from '../terminology.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('TerminologyService (P1 item 7)', () => {
  let pool: Pool;
  let orgId: string;
  const terminology = new TerminologyService();

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgId = await createTestOrg(pool, 'Terminology Test Org');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('falls back to the app-supplied default when no override is configured', async () => {
    const label = await withOrgContext(orgId, (db) => terminology.resolve(db, orgId, 'com.hexyrn.requisite', 'requisition', 'Requisition'), pool);
    expect(label).toBe('Requisition');
  });

  it('returns the org override once configured, without changing the stable term_key', async () => {
    await withOrgContext(orgId, (db) => terminology.setOverride(db, orgId, 'com.hexyrn.requisite', 'requisition', 'Purchase Request'), pool);
    const label = await withOrgContext(orgId, (db) => terminology.resolve(db, orgId, 'com.hexyrn.requisite', 'requisition', 'Requisition'), pool);
    expect(label).toBe('Purchase Request');

    // The stable key itself never changes - callers still look it up by 'requisition'.
    const all = await withOrgContext(orgId, (db) => terminology.getAllOverrides(db, orgId, 'com.hexyrn.requisite'), pool);
    expect(all.requisition).toBe('Purchase Request');
  });

  it('overrides are isolated per organisation', async () => {
    const orgB = await createTestOrg(pool, 'Terminology Org B');
    const label = await withOrgContext(orgB, (db) => terminology.resolve(db, orgB, 'com.hexyrn.requisite', 'requisition', 'Requisition'), pool);
    expect(label).toBe('Requisition'); // org B never sees org A's override
  });
});
