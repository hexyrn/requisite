import 'dotenv/config';
import { Pool } from 'pg';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * Test-only helpers: connect to the docker-compose `postgres_test` service
 * and apply the same migrations used in production, so security tests run
 * against real Postgres + real RLS policies, not a mock.
 */
export function testConnectionString(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set - see .env.example');
  }
  return url;
}

export async function resetTestDatabase(pool: Pool): Promise<void> {
  await pool.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);
}

export async function applyMigrations(pool: Pool): Promise<void> {
  const dir = join(__dirname, '..', 'db', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    await pool.query(sql);
  }
}

export async function setUpTestDatabase(pool: Pool): Promise<void> {
  await resetTestDatabase(pool);
  await applyMigrations(pool);
}

/** Creates an installation (if none exists yet on this pool) and a fresh organisation. Returns the new org's id. */
export async function createTestOrg(pool: Pool, name = 'Test Org'): Promise<string> {
  const { randomUUID } = await import('crypto');
  const { withOrgContext } = await import('../db/org-context');
  const orgId = randomUUID();
  await withOrgContext(
    orgId,
    async (db) => {
      let installation = await db.selectFrom('installations').selectAll().executeTakeFirst();
      if (!installation) {
        installation = await db
          .insertInto('installations')
          .values({ core_version: 'test', config: {} })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      await db
        .insertInto('organisations')
        .values({
          id: orgId,
          installation_id: installation.id,
          name,
          display_name: name,
          default_currency: 'USD',
          timezone: 'UTC',
          locale: 'en-US',
          financial_year_start_month: 1,
        })
        .execute();
    },
    pool,
  );
  return orgId;
}

/** Real, validly-signed test license (P2 item 21) - uses the TEST keypair (src/platform/licensing/keys.ts), never a fake payload. */
export async function createTestLicense(
  appId: string,
  organisationId: string,
  majorVersion = 1,
  supportExpiresAt: string | null = null,
) {
  const { LicenseSigner } = await import('../vendor-tools/licensing/license-signer');
  const { TEST_LICENSE_PRIVATE_KEY_PEM } = await import('../vendor-tools/licensing/test-keys');
  const signer = new LicenseSigner(TEST_LICENSE_PRIVATE_KEY_PEM);
  return signer.issue({ appId, organisationId, majorVersion, supportExpiresAt });
}
