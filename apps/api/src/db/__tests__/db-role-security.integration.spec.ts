/**
 * P3 item 18: "Verify production DB roles: runtime app role must not be
 * superuser, not BYPASSRLS, not own protected tables if that bypasses
 * intended RLS... Verify FORCE ROW LEVEL SECURITY."
 *
 * Architecture §8's entire RLS design (and every RLS-isolation test in
 * rls-matrix.integration.spec.ts) is only meaningful if the connecting
 * database role genuinely cannot bypass row-level security. A superuser or
 * a role with the BYPASSRLS attribute bypasses FORCE ROW LEVEL SECURITY
 * silently - every existing RLS test would keep "passing" even if RLS were
 * completely inert, because superuser reads would just happen to return
 * only the requested org's rows anyway (single-org test fixtures), giving
 * false confidence. This file is the missing automated check: rather than
 * relying on operator documentation (.env.example's "must NOT be a
 * superuser" comment) being followed correctly, it asserts the actual
 * connected role's privileges at test time, and fails loudly - not
 * silently - if a production/CI database is ever misconfigured with an
 * overprivileged role.
 *
 * Also asserts every organisation-owned table (heuristically: has an
 * `organisation_id` column) has RLS both ENABLED and FORCED - catching the
 * case where a future migration adds a new organisation-owned table but
 * forgets `ENABLE ROW LEVEL SECURITY` / `FORCE ROW LEVEL SECURITY`, which
 * would otherwise be silently exploitable by exactly the same class of bug
 * ADR 0005 and Architecture §8.1 are designed to prevent.
 */
import { Pool } from 'pg';
import { attachPoolErrorHandler } from '../pool';
import { setUpTestDatabase } from '../../test-utils/test-db';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

// Installation-level / cross-org registry tables that are architecturally
// NOT organisation-owned data (ADR 0005, Architecture §7) and therefore
// correctly have no RLS policy at all, even though some carry an
// organisation_id-shaped column used only as a routing pointer (e.g.
// dispatch_queue, api_credential_lookup) rather than as scoped business data.
const KNOWN_NON_RLS_TABLES = new Set([
  'installations',
  'bootstrap_tokens',
  'installation_audit_events',
  'installed_applications',
  'capability_providers',
  'event_consumer_registrations',
  'report_templates',
  'dispatch_queue',
  'widget_definitions',
  'dataset_definitions',
  'dataset_relationships',
  'search_entity_registrations',
  'import_definitions',
  'event_schemas',
  'connector_registrations',
  'api_credential_lookup',
  'schema_migrations',
  'app_migrations',
]);

describeIfDb('P3 item 18: production DB role / RLS enforcement security review', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 2 }));
    await setUpTestDatabase(pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('the connecting application role is NOT a superuser', async () => {
    const res = await pool.query<{ rolsuper: boolean }>(
      'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].rolsuper).toBe(false);
  });

  it('the connecting application role does NOT have BYPASSRLS', async () => {
    const res = await pool.query<{ rolbypassrls: boolean }>(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].rolbypassrls).toBe(false);
  });

  it('every organisation-owned table (has an organisation_id column) has RLS both enabled and FORCED', async () => {
    const res = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = 'organisation_id'
        )
    `);

    expect(res.rows.length).toBeGreaterThan(10); // sanity: this should find the bulk of the schema

    const violations = res.rows.filter(
      (r) => !KNOWN_NON_RLS_TABLES.has(r.relname) && (!r.relrowsecurity || !r.relforcerowsecurity),
    );
    expect(violations).toEqual([]);
  });

  it('no table outside the documented allowlist is missing RLS entirely', async () => {
    const res = await pool.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = false
    `);
    const unexpected = res.rows
      .map((r) => r.relname)
      .filter((name) => !KNOWN_NON_RLS_TABLES.has(name));
    expect(unexpected).toEqual([]);
  });
});
