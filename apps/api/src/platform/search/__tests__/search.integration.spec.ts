import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { SearchService } from '../search.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('SearchService - permission-safe platform search (P2 item 9)', () => {
  let pool: Pool;
  let orgA: string;
  let orgB: string;
  const search = new SearchService();

  function subject(permissions: string[], organisationId: string) {
    return { userAccountId: randomUUID(), organisationId, grantedPermissions: new Set(permissions) };
  }

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Search Org A');
    orgB = await createTestOrg(pool, 'Search Org B');

    await withOrgContext(orgA, (db) => search.registerEntityType(db, 'reference.widget', 'com.hexyrn.reference', 'reference.widget.view', '{label}', '/widgets/{id}'), pool);
    await withOrgContext(orgA, (db) => search.registerEntityType(db, 'reference.secretreport', 'com.hexyrn.reference', 'reference.secretreport.view', '{label}', '/secret/{id}'), pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('finds an indexed entity by full-text search when the caller holds the required permission', async () => {
    const entityId = randomUUID();
    await withOrgContext(orgA, (db) => search.indexUpsert(db, orgA, 'reference.widget', entityId, 'Titanium Bracket Assembly', 'Titanium Bracket Assembly', `/widgets/${entityId}`), pool);
    const results = await withOrgContext(orgA, (db) => search.search(db, subject(['reference.widget.view'], orgA), 'titanium'), pool);
    expect(results).toHaveLength(1);
    expect(results[0].entityId).toBe(entityId);
  });

  it('PERMISSION SAFETY: an entity type the caller lacks permission for never appears in results, even with a matching query', async () => {
    const entityId = randomUUID();
    await withOrgContext(orgA, (db) => search.indexUpsert(db, orgA, 'reference.secretreport', entityId, 'Confidential Merger Analysis', 'Confidential Merger Analysis', `/secret/${entityId}`), pool);
    const results = await withOrgContext(orgA, (db) => search.search(db, subject(['reference.widget.view'], orgA), 'confidential'), pool);
    expect(results).toHaveLength(0);
  });

  it('a subject with permission on both entity types sees results across them', async () => {
    const results = await withOrgContext(orgA, (db) => search.search(db, subject(['reference.widget.view', 'reference.secretreport.view'], orgA), 'merger'), pool);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('ORGANISATION ISOLATION: an entity indexed under org A is not returned when searching from org B', async () => {
    const entityId = randomUUID();
    await withOrgContext(orgA, (db) => search.indexUpsert(db, orgA, 'reference.widget', entityId, 'Unique Zephyr Widget Alpha', 'Unique Zephyr Widget Alpha', `/widgets/${entityId}`), pool);
    const resultsFromB = await withOrgContext(orgB, (db) => search.search(db, subject(['reference.widget.view'], orgB), 'zephyr'), pool);
    expect(resultsFromB).toHaveLength(0);
  });

  it('removeFromIndex takes an entity out of future search results', async () => {
    const entityId = randomUUID();
    await withOrgContext(orgA, (db) => search.indexUpsert(db, orgA, 'reference.widget', entityId, 'Ephemeral Gadget', 'Ephemeral Gadget', `/widgets/${entityId}`), pool);
    await withOrgContext(orgA, (db) => search.removeFromIndex(db, orgA, 'reference.widget', entityId), pool);
    const results = await withOrgContext(orgA, (db) => search.search(db, subject(['reference.widget.view'], orgA), 'ephemeral'), pool);
    expect(results).toHaveLength(0);
  });

  it('rejects an empty search query', async () => {
    await expect(withOrgContext(orgA, (db) => search.search(db, subject(['reference.widget.view'], orgA), ''), pool)).rejects.toThrow(/must not be empty/i);
  });

  it('a subject with no matching permissions gets zero results without error', async () => {
    const results = await withOrgContext(orgA, (db) => search.search(db, subject([], orgA), 'anything'), pool);
    expect(results).toHaveLength(0);
  });
});
