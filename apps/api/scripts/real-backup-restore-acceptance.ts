/**
 * REAL pg_dump/pg_restore acceptance test (P3 items 13/14). Not a Jest
 * test - a standalone script, because it deliberately runs against a
 * dedicated, isolated database (never the shared dev/test database other
 * suites use) and shells out to the actual PostgreSQL client binaries
 * discovered on this machine, exactly as a production deployment would.
 *
 * Usage: PG_DUMP_PATH=... PG_RESTORE_PATH=... npx ts-node scripts/real-backup-restore-acceptance.ts
 *
 * Records exact tool versions and prints a clear PASS/FAIL per step.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

const execFileAsync = promisify(execFile);

const PG_DUMP_PATH = process.env.PG_DUMP_PATH ?? 'pg_dump';
const PG_RESTORE_PATH = process.env.PG_RESTORE_PATH ?? 'pg_restore';
const TEST_DB_HOST = process.env.HARNESS_PG_HOST ?? '127.0.0.1';
const TEST_DB_PORT = process.env.HARNESS_PG_PORT ?? '5432';
const TEST_DB_USER = process.env.HARNESS_PG_USER ?? 'hexyrn';
const TEST_DB_PASSWORD = process.env.HARNESS_PG_PASSWORD ?? 'hexyrn_test_password';
const TEST_DB_NAME = process.env.HARNESS_PG_DB ?? 'hexyrn_backup_restore_test';
const CONNECTION_STRING = `postgres://${TEST_DB_USER}:${TEST_DB_PASSWORD}@${TEST_DB_HOST}:${TEST_DB_PORT}/${TEST_DB_NAME}`;

let passed = 0;
let failed = 0;

function step(name: string, ok: boolean, detail?: string) {
  const mark = ok ? 'PASS' : 'FAIL';
  // eslint-disable-next-line no-console
  console.log(`[${mark}] ${name}${detail ? ' - ' + detail : ''}`);
  if (ok) passed++;
  else failed++;
}

async function main() {
  // eslint-disable-next-line no-console
  console.log(`=== Real pg_dump/pg_restore acceptance test ===`);
  const dumpVersion = await execFileAsync(PG_DUMP_PATH, ['--version']).then((r) => r.stdout.trim());
  const restoreVersion = await execFileAsync(PG_RESTORE_PATH, ['--version']).then((r) => r.stdout.trim());
  // eslint-disable-next-line no-console
  console.log(`pg_dump: ${dumpVersion}`);
  // eslint-disable-next-line no-console
  console.log(`pg_restore: ${restoreVersion}`);
  // eslint-disable-next-line no-console
  console.log(`Target database (ISOLATED, not the dev/test DB): ${TEST_DB_NAME}@${TEST_DB_HOST}:${TEST_DB_PORT}`);

  const pool = new Pool({ connectionString: CONNECTION_STRING });
  const storageDir = await fs.mkdtemp(join(tmpdir(), 'hexyrn-real-backup-storage-'));
  const backupDir = await fs.mkdtemp(join(tmpdir(), 'hexyrn-real-backup-'));

  // A single held connection for all seeding/verification queries below -
  // RLS's `SET LOCAL`/session `set_config` must stay on the SAME physical
  // connection for subsequent queries to see it; a bare `pool.query()` per
  // call can silently hop to a different pooled connection.
  const client = await pool.connect();

  try {
    // --- Seed: organisation, owner user, a Requisite-shaped row, an uploaded file ---
    const orgId = randomUUID();
    await client.query(
      `INSERT INTO installations (core_version) SELECT '0.1.0-real-backup-test' WHERE NOT EXISTS (SELECT 1 FROM installations)`,
    );
    const installation = await client.query<{ id: string }>('SELECT id FROM installations LIMIT 1');
    await client.query('SELECT set_config($1, $2, false)', ['app.current_organisation_id', orgId]);
    await client.query(
      `INSERT INTO organisations (id, installation_id, name, display_name, default_currency, timezone, locale, financial_year_start_month)
       VALUES ($1, $2, 'Real Backup Test Org', 'Real Backup Test Org', 'USD', 'UTC', 'en-US', 1)`,
      [orgId, installation.rows[0].id],
    );
    const userId = randomUUID();
    await client.query(
      `INSERT INTO user_accounts (id, organisation_id, email, password_hash, is_active) VALUES ($1, $2, 'real-backup-owner@test.local', 'not-a-real-hash-just-for-this-script', true)`,
      [userId, orgId],
    );
    const CANARY_REASON = `REAL-BACKUP-CANARY-${randomUUID()}`;
    await fs.writeFile(join(storageDir, 'test-upload.txt'), 'this is a real uploaded file for the backup/restore acceptance test');

    step('Seeded organisation/user in isolated database', true, `org=${orgId}`);

    // --- Real backup via the actual pg_dump binary ---
    const { createBackup, verifyBackupIntegrity, restoreBackup, realPgDump, realPgRestore } = await import('../src/platform/backup/backup.service');
    const backupResult = await createBackup({
      destinationDir: backupDir,
      storageRootDir: storageDir,
      pool,
      runPgDump: realPgDump(CONNECTION_STRING, PG_DUMP_PATH),
    });
    step('Real pg_dump executed and produced a backup', true, backupResult.backupDir);

    const integrity = await verifyBackupIntegrity(backupDir);
    step('Backup manifest/checksums verify (real dump file, real SHA-256)', integrity.valid, integrity.issues.join('; '));

    // --- Alter/delete data ---
    await client.query('UPDATE user_accounts SET email = $1 WHERE id = $2', ['CORRUPTED@test.local', userId]);
    await fs.writeFile(join(storageDir, 'test-upload.txt'), 'CORRUPTED CONTENT');
    step('Deliberately altered live data + uploaded file', true);

    // --- Real restore via the actual pg_restore binary ---
    const restoreResult = await restoreBackup({
      backupDir,
      storageRootDir: storageDir,
      runPgRestore: realPgRestore(CONNECTION_STRING, PG_RESTORE_PATH),
      confirmed: true,
    });
    step('Real pg_restore executed', true, `filesRestored=${restoreResult.filesRestored}`);

    // --- Verify original data returned - pg_restore reconnects the
    // server-side state, but this script's own `client` connection may
    // have had its RLS session-level set_config wiped by the restore
    // (which drops/recreates the whole database's contents) - re-assert
    // org context defensively before reading. ---
    await client.query('SELECT set_config($1, $2, false)', ['app.current_organisation_id', orgId]);
    const afterRestore = await client.query<{ email: string }>('SELECT email FROM user_accounts WHERE id = $1', [userId]);
    step('Original user email restored (real pg_restore, not a fake)', afterRestore.rows[0]?.email === 'real-backup-owner@test.local', afterRestore.rows[0]?.email);

    const fileContent = await fs.readFile(join(storageDir, 'test-upload.txt'), 'utf8');
    step('Original uploaded file content restored', fileContent.includes('real uploaded file'), fileContent.slice(0, 40));

    void CANARY_REASON;
  } catch (err) {
    step('Unexpected error during acceptance test', false, err instanceof Error ? err.message : String(err));
  } finally {
    client.release();
    await pool.end();
  }

  // eslint-disable-next-line no-console
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
