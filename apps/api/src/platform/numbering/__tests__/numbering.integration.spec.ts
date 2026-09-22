import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { NumberingService } from '../numbering.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('NumberingService - concurrency safety against real Postgres (P1 item 8)', () => {
  let pool: Pool;
  let orgId: string;
  const numbering = new NumberingService();

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 20 }));
    await setUpTestDatabase(pool);
    orgId = randomUUID();
    await withOrgContext(orgId, async (db) => {
      const inst = await db.insertInto('installations').values({ core_version: 'test', config: {} }).returningAll().executeTakeFirstOrThrow();
      await db
        .insertInto('organisations')
        .values({ id: orgId, installation_id: inst.id, name: 'Org', display_name: 'Org', default_currency: 'USD', timezone: 'UTC', locale: 'en-US', financial_year_start_month: 1 })
        .execute();
      await numbering.registerSequence(db, orgId, { appId: 'com.hexyrn.reference', sequenceKey: 'requisition', prefix: 'REQ-', padLength: 6 });
    }, pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('formats numbers as PREFIX + zero-padded sequence, e.g. REQ-000001', async () => {
    const n = await withOrgContext(orgId, (db) => numbering.next(db, orgId, 'com.hexyrn.reference', 'requisition'), pool);
    expect(n).toMatch(/^REQ-\d{6}$/);
  });

  it('CONCURRENCY: 50 parallel next() calls on the same sequence produce 50 unique, contiguous numbers', async () => {
    const seqKey = 'concurrency-test';
    await withOrgContext(orgId, (db) => numbering.registerSequence(db, orgId, { appId: 'com.hexyrn.reference', sequenceKey: seqKey, prefix: 'CT-', padLength: 6 }), pool);

    const CONCURRENCY = 50;
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () => withOrgContext(orgId, (db) => numbering.next(db, orgId, 'com.hexyrn.reference', seqKey), pool)),
    );

    const numbers = results.map((r) => parseInt(r.replace('CT-', ''), 10));
    const unique = new Set(numbers);
    expect(unique.size).toBe(CONCURRENCY); // no duplicates
    const sorted = [...unique].sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: CONCURRENCY }, (_, i) => i + 1)); // contiguous, 1..50, no gaps
  });

  it('organisation isolation: two orgs issuing from a sequence with the same key never collide', async () => {
    const orgB = randomUUID();
    await withOrgContext(orgB, async (db) => {
      const installation = await db.selectFrom('installations').selectAll().executeTakeFirstOrThrow();
      await db
        .insertInto('organisations')
        .values({ id: orgB, installation_id: installation.id, name: 'Org B', display_name: 'Org B', default_currency: 'USD', timezone: 'UTC', locale: 'en-US', financial_year_start_month: 1 })
        .execute();
      await numbering.registerSequence(db, orgB, { appId: 'com.hexyrn.reference', sequenceKey: 'requisition', prefix: 'REQ-', padLength: 6 });
    }, pool);

    const [fromA, fromB] = await Promise.all([
      withOrgContext(orgId, (db) => numbering.next(db, orgId, 'com.hexyrn.reference', 'requisition'), pool),
      withOrgContext(orgB, (db) => numbering.next(db, orgB, 'com.hexyrn.reference', 'requisition'), pool),
    ]);
    // Org B's sequence starts fresh at 1 regardless of Org A's count - proves isolation.
    expect(fromB).toBe('REQ-000001');
    expect(fromA).not.toBe(fromB);
  });

  it('year-reset sequences reset to 1 when last_reset_year differs from the current year', async () => {
    const seqKey = 'year-reset-test';
    await withOrgContext(orgId, (db) => numbering.registerSequence(db, orgId, { appId: 'com.hexyrn.reference', sequenceKey: seqKey, prefix: 'PO-', padLength: 4, yearReset: true }), pool);

    const first = await withOrgContext(orgId, (db) => numbering.next(db, orgId, 'com.hexyrn.reference', seqKey), pool);
    const currentYear = new Date().getFullYear();
    expect(first).toBe(`PO-${currentYear}-0001`);

    // Simulate a prior year by forcing last_reset_year backward, then issuing again - must reset to 1.
    await withOrgContext(orgId, (db) => db.updateTable('numbering_sequences').set({ last_reset_year: currentYear - 1 }).where('organisation_id', '=', orgId).where('sequence_key', '=', seqKey).execute(), pool);
    const afterYearChange = await withOrgContext(orgId, (db) => numbering.next(db, orgId, 'com.hexyrn.reference', seqKey), pool);
    expect(afterYearChange).toBe(`PO-${currentYear}-0001`);
  });

  it('throws for an unregistered sequence rather than silently creating one', async () => {
    await expect(withOrgContext(orgId, (db) => numbering.next(db, orgId, 'com.hexyrn.reference', 'never-registered'), pool)).rejects.toThrow(/not registered/i);
  });
});
