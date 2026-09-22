/**
 * Lightweight, explicit, versioned SQL migration runner.
 *
 * Not run automatically on boot (per P0 item 4 - "applied via an explicit
 * CLI step"). Invoke with: npm run migrate --workspace apps/api
 *
 * Applies every .sql file in ./migrations, in filename order, that is not
 * already recorded in the schema_migrations table. Each file runs inside its
 * own transaction; failure aborts without marking that file as applied.
 *
 * P3 item 18 ("separate migration/admin role where appropriate"): migrations
 * create tables, alter schema, and issue `ENABLE`/`FORCE ROW LEVEL SECURITY`
 * - genuinely privileged operations the runtime API role must NOT be able to
 * perform (see apps/api/src/db/pool.ts and
 * db-role-security.integration.spec.ts, which assert the RUNTIME role is
 * non-superuser/non-BYPASSRLS - that check only means something if the
 * runtime role is also not the schema owner). Migrations therefore connect
 * with `MIGRATE_DATABASE_URL` (the schema-owning, more-privileged role -
 * `hexyrn` in docker-compose.yml / docker/postgres-init/01-app-role.sh),
 * falling back to `DATABASE_URL` for backward compatibility with any
 * existing single-role setup (a valid, simpler configuration for a small
 * self-hosted install that accepts the smaller blast-radius reduction).
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

async function main() {
  const connectionString = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('MIGRATE_DATABASE_URL (or DATABASE_URL) is not set');
  }
  const pool = new Pool({ connectionString });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const dir = join(__dirname, 'migrations');
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows: appliedRows } = await pool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const applied = new Set(appliedRows.map((r) => r.filename));

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(dir, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        // eslint-disable-next-line no-console
        console.log(`applied: ${file}`);
        appliedCount++;
      } catch (err) {
        await client.query('ROLLBACK');
        // eslint-disable-next-line no-console
        console.error(`FAILED: ${file}`);
        throw err;
      } finally {
        client.release();
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      appliedCount === 0 ? 'No pending migrations.' : `Applied ${appliedCount} migration(s).`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
