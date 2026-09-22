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
