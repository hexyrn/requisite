import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Pool } from 'pg';
import { CORE_VERSION } from '../core-version';

const execFileAsync = promisify(execFile);

/**
 * Core backup system (P3 items 9-13). Architecture §10's UI ("Backup Now,
 * destination, schedule, retention, last successful backup") is not built
 * here - this file is the underlying "coordinated backup unit" mechanism
 * §10 describes that UI as orchestrating, implemented as a real,
 * independently testable module rather than a stub.
 *
 * SANDBOX LIMITATION, STATED PLAINLY: this module shells out to the
 * `pg_dump`/`pg_restore` binaries (standard PostgreSQL client tools,
 * expected to be present on the host or in the container image - exactly
 * as ordinary for any Postgres-backed product; they are NOT bundled or
 * reimplemented here). Neither binary is installed in the sandbox this
 * code was written and tested in, so the actual dump/restore EXECUTION
 * could not be run end-to-end here - only verified by code review and by
 * unit-testing every part of this module that does not require the
 * binaries (manifest generation, checksum computation, integrity
 * verification, retention policy, version-compatibility checks) via
 * injectable dump/restore functions. This is recorded as a genuine,
 * outstanding verification gap for the final P3 report, not glossed over.
 */

export interface BackupManifest {
  formatVersion: 1;
  createdAt: string; // ISO 8601
  coreVersion: string;
  installedApps: Array<{ appId: string; version: string }>;
  database: { filename: string; sha256: string; sizeBytes: number };
  files: { includedFileCount: number; sha256: string; sizeBytes: number } | null;
  /**
   * Item 10: the exact consistency guarantee, not an unsupported claim of
   * "atomic." A single `pg_dump` run reads from one consistent MVCC
   * snapshot (Postgres's own `REPEATABLE READ`-equivalent snapshot
   * isolation for the dump transaction) - the DATABASE portion is
   * therefore internally consistent as of one instant. Uploaded files in
   * this codebase are immutable once stored (FileService never rewrites an
   * existing storage key - see storage-provider.ts), only created, so
   * copying the files directory either before or after the DB snapshot
   * captures a state that is AT WORST "files that existed at backup time
   * plus possibly a few uploaded in the brief window around the DB
   * snapshot" - never a torn/partially-written file, and never a file
   * whose row was captured by the DB snapshot but whose bytes are missing
   * (files are written to disk BEFORE their row commits - see
   * FileService.store). This is the actual, bounded guarantee; it is not
   * "the whole backup is one atomic transaction," which would be false.
   */
  consistencyNote: string;
}

export interface CreateBackupOptions {
  destinationDir: string;
  storageRootDir: string;
  pool: Pool;
  /** Injectable so unit tests never need the real pg_dump binary; production wiring passes realPgDump. */
  runPgDump: (outputPath: string) => Promise<void>;
}

export interface CreateBackupResult {
  backupDir: string;
  manifest: BackupManifest;
}

const CONSISTENCY_NOTE =
  'Database: one consistent MVCC snapshot via a single pg_dump run. Files: copied separately (immutable-once-stored, so no torn files); NOT part of the same DB snapshot transaction - a file uploaded in the brief window around the DB dump may or may not be included, but never partially. This is snapshot-plus-immutable-files consistency, not multi-resource atomicity.';

async function sha256OfFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const buf = await fs.readFile(path);
  return { sha256: createHash('sha256').update(buf).digest('hex'), sizeBytes: buf.length };
}

/** Deterministic combined digest over every file's own digest + relative path, so reordering/renaming is detected. */
async function sha256OfDirectory(dir: string): Promise<{ sha256: string; sizeBytes: number; fileCount: number }> {
  const entries = await listFilesRecursive(dir);
  entries.sort();
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for (const rel of entries) {
    const full = join(dir, rel);
    const buf = await fs.readFile(full);
    sizeBytes += buf.length;
    hash.update(rel);
    hash.update(createHash('sha256').update(buf).digest());
  }
  return { sha256: hash.digest('hex'), sizeBytes, fileCount: entries.length };
}

async function listFilesRecursive(dir: string, prefix = ''): Promise<string[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return []; // no files uploaded yet - a valid, empty backup
    throw err;
  }
  const results: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(join(dir, entry.name), rel)));
    } else {
      results.push(rel);
    }
  }
  return results;
}

async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(src, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

export async function createBackup(options: CreateBackupOptions): Promise<CreateBackupResult> {
  const backupDir = resolve(options.destinationDir);
  await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });

  const dbFilename = 'database.dump';
  const dbPath = join(backupDir, dbFilename);
  await options.runPgDump(dbPath);
  const dbDigest = await sha256OfFile(dbPath);

  let filesInfo: BackupManifest['files'] = null;
  const filesDestDir = join(backupDir, 'files');
  const sourceHasFiles = await fs
    .readdir(options.storageRootDir)
    .then((entries) => entries.length > 0)
    .catch(() => false);
  if (sourceHasFiles) {
    await copyDirectory(options.storageRootDir, filesDestDir);
    const dirDigest = await sha256OfDirectory(filesDestDir);
    filesInfo = { includedFileCount: dirDigest.fileCount, sha256: dirDigest.sha256, sizeBytes: dirDigest.sizeBytes };
  }

  const installedApps = await options.pool
    .query<{ app_id: string; version: string }>('SELECT app_id, version FROM installed_applications ORDER BY app_id')
    .then((r) => r.rows.map((row) => ({ appId: row.app_id, version: row.version })));

  const manifest: BackupManifest = {
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    coreVersion: CORE_VERSION,
    installedApps,
    database: { filename: dbFilename, sha256: dbDigest.sha256, sizeBytes: dbDigest.sizeBytes },
    files: filesInfo,
    consistencyNote: CONSISTENCY_NOTE,
  };

  await fs.writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  return { backupDir, manifest };
}

export interface IntegrityCheckResult {
  valid: boolean;
  issues: string[];
  manifest: BackupManifest | null;
}

/** Item 12/9: "verify backup integrity" - re-reads the manifest and recomputes every checksum it recorded. */
export async function verifyBackupIntegrity(backupDir: string): Promise<IntegrityCheckResult> {
  const issues: string[] = [];
  let manifest: BackupManifest | null = null;
  try {
    const raw = await fs.readFile(join(backupDir, 'manifest.json'), 'utf8');
    manifest = JSON.parse(raw) as BackupManifest;
  } catch (err) {
    return { valid: false, issues: [`Could not read manifest.json: ${err instanceof Error ? err.message : String(err)}`], manifest: null };
  }

  if (manifest.formatVersion !== 1) {
    issues.push(`Unrecognised backup manifest formatVersion ${manifest.formatVersion} - this version of Hexyrn Core cannot verify or restore it.`);
    return { valid: false, issues, manifest };
  }

  try {
    const dbDigest = await sha256OfFile(join(backupDir, manifest.database.filename));
    if (dbDigest.sha256 !== manifest.database.sha256) {
      issues.push(`Database dump checksum mismatch - the file may be corrupted or tampered with (expected ${manifest.database.sha256}, got ${dbDigest.sha256}).`);
    }
    if (dbDigest.sizeBytes !== manifest.database.sizeBytes) {
      issues.push(`Database dump size mismatch (expected ${manifest.database.sizeBytes} bytes, got ${dbDigest.sizeBytes}).`);
    }
  } catch (err) {
    issues.push(`Could not read database dump file: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (manifest.files) {
    try {
      const dirDigest = await sha256OfDirectory(join(backupDir, 'files'));
      if (dirDigest.sha256 !== manifest.files.sha256) {
        issues.push(`Files archive checksum mismatch - the files directory may be corrupted, tampered with, or incomplete (expected ${manifest.files.sha256}, got ${dirDigest.sha256}).`);
      }
      if (dirDigest.fileCount !== manifest.files.includedFileCount) {
        issues.push(`Files archive file count mismatch (expected ${manifest.files.includedFileCount}, got ${dirDigest.fileCount}).`);
      }
    } catch (err) {
      issues.push(`Could not read files archive: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { valid: issues.length === 0, issues, manifest };
}

export interface CompatibilityCheckResult {
  compatible: boolean;
  reason: string;
}

/**
 * Item 12: "inspect manifest/version compatibility" before restoring. Only
 * checks that a restore is being attempted against a Core build that could
 * plausibly understand the backed-up schema - it does NOT run migrations
 * itself (that is a separate, later restore step against the restored
 * database, using the ordinary migration runner).
 */
export function checkRestoreCompatibility(manifest: BackupManifest, runningCoreVersion: string = CORE_VERSION): CompatibilityCheckResult {
  const backupMajor = parseInt(manifest.coreVersion.replace(/^[^\d]*/, '').split('.')[0], 10);
  const runningMajor = parseInt(runningCoreVersion.replace(/^[^\d]*/, '').split('.')[0], 10);
  if (Number.isNaN(backupMajor) || Number.isNaN(runningMajor)) {
    return { compatible: false, reason: `Could not parse a major version from "${manifest.coreVersion}" or "${runningCoreVersion}".` };
  }
  if (backupMajor > runningMajor) {
    return {
      compatible: false,
      reason: `This backup was created by Hexyrn Core ${manifest.coreVersion}, newer than the running ${runningCoreVersion} - restoring a newer backup onto an older Core build is not supported. Upgrade Core first.`,
    };
  }
  return { compatible: true, reason: `Backup Core version ${manifest.coreVersion} is compatible with running ${runningCoreVersion}.` };
}

/**
 * Item 9/10: "retention" - keep-last-N, applied over a directory of
 * timestamped backup subdirectories (each containing its own manifest.json,
 * as created by createBackup). Deletes the oldest backups beyond the limit
 * and returns which directory names were removed, so a caller can log/audit
 * it - retention deletion is real data loss and should never happen silently
 * uninspectable.
 */
export async function applyRetentionPolicy(backupsRootDir: string, keepLastN: number): Promise<{ kept: string[]; deleted: string[] }> {
  if (keepLastN < 1) throw new Error('keepLastN must be at least 1 - a retention policy that keeps zero backups is not a backup system.');
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(backupsRootDir, { withFileTypes: true });
  } catch (err: any) {
    if (err?.code === 'ENOENT') return { kept: [], deleted: [] };
    throw err;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(); // ISO-8601-prefixed names sort chronologically
  const kept = dirs.slice(-keepLastN);
  const toDelete = dirs.slice(0, Math.max(0, dirs.length - keepLastN));
  for (const name of toDelete) {
    await fs.rm(join(backupsRootDir, name), { recursive: true, force: true });
  }
  return { kept, deleted: toDelete };
}

export interface RestoreBackupOptions {
  backupDir: string;
  storageRootDir: string;
  runPgRestore: (dumpPath: string) => Promise<void>;
  /** Set true only after the operator has explicitly confirmed the destructive overwrite (item 12's "explicitly destructive-warned flow"). */
  confirmed: boolean;
  runningCoreVersion?: string;
}

export interface RestoreBackupResult {
  manifest: BackupManifest;
  filesRestored: number;
}

/**
 * Item 12 orchestrator: verify integrity -> check compatibility -> restore
 * DB -> restore files -> return what was restored for a post-restore health
 * check to build on. Refuses to proceed (throws, no partial destructive
 * action) if integrity or compatibility checks fail, or if `confirmed` is
 * not explicitly true - there is no code path that silently overwrites the
 * live database.
 */
export async function restoreBackup(options: RestoreBackupOptions): Promise<RestoreBackupResult> {
  if (!options.confirmed) {
    throw new Error('Refusing to restore: this is a destructive operation that overwrites the current database and files. Pass confirmed: true only after explicit operator confirmation.');
  }

  const integrity = await verifyBackupIntegrity(options.backupDir);
  if (!integrity.valid || !integrity.manifest) {
    throw new Error(`Refusing to restore: backup failed integrity verification.\n${integrity.issues.join('\n')}`);
  }

  const compatibility = checkRestoreCompatibility(integrity.manifest, options.runningCoreVersion);
  if (!compatibility.compatible) {
    throw new Error(`Refusing to restore: ${compatibility.reason}`);
  }

  const dbPath = join(resolve(options.backupDir), integrity.manifest.database.filename);
  await options.runPgRestore(dbPath);

  let filesRestored = 0;
  if (integrity.manifest.files) {
    const filesBackupDir = join(resolve(options.backupDir), 'files');
    // Restore is a full replace, not a merge - matches Architecture §10's
    // "explicitly destructive-warned flow (confirmation step naming exactly
    // what will be overwritten)."
    await fs.rm(options.storageRootDir, { recursive: true, force: true });
    await copyDirectory(filesBackupDir, options.storageRootDir);
    filesRestored = integrity.manifest.files.includedFileCount;
  }

  return { manifest: integrity.manifest, filesRestored };
}

/** Real (non-test) pg_dump invocation - production wiring for CreateBackupOptions.runPgDump. */
/**
 * P3 item 13/14 real-binary finding: `--data-only` is deliberate, not an
 * oversight. A schema+data dump (`pg_dump`'s default) requires
 * `pg_restore --clean` to later DROP/CREATE tables, which requires TABLE
 * OWNERSHIP - a materially larger privilege than the connecting role
 * needs for anything else it does. Restoring assumes the target database
 * already has the correct schema applied via the ordinary migration
 * runner (a genuine prerequisite of any restore - see restoreBackup()'s
 * orchestration and docs/OPERATOR_GUIDE.md §6), so only DATA needs to
 * round-trip through backup/restore. This also directly determines what
 * privilege the backup role needs: `--data-only` only ever issues
 * `COPY ... TO/FROM stdout` (SELECT/INSERT/DELETE row access, gated by
 * RLS), never DDL - so a role with BYPASSRLS + DML grants (never table
 * ownership) is sufficient. See docker/postgres-init/01-app-role.sh's
 * `hexyrn_backup` role for the concrete, documented reason it needs
 * BYPASSRLS at all: a full-database dump has no per-request organisation
 * context to set, and FORCE ROW LEVEL SECURITY applies even to the table
 * owner, so a dump/restore role that ISN'T exempted from RLS cannot read
 * or write organisation-scoped tables at all - confirmed by attempting a
 * real dump against a FORCE-RLS-enabled database during this phase's
 * development (see P3-ENVIRONMENT-VERIFICATION.md).
 */
export function realPgDump(connectionString: string, pgDumpPath = process.env.PG_DUMP_PATH ?? 'pg_dump') {
  return async (outputPath: string): Promise<void> => {
    try {
      await execFileAsync(pgDumpPath, ['--format=custom', '--data-only', '--file', outputPath, connectionString]);
    } catch (err) {
      throw new Error(
        `pg_dump failed (looked for "${pgDumpPath}" - override with PG_DUMP_PATH if it's not on PATH): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}

/** Real (non-test) pg_restore invocation. Destructive - callers must have already confirmed with the operator. */
/**
 * `--data-only --disable-triggers` matches realPgDump's `--data-only`
 * (see its doc comment) - restores rows into an ALREADY-MIGRATED schema
 * (the target database must have had migrations applied first; restoring
 * onto a bare/never-migrated database is not a supported path).
 * `--disable-triggers` is required for `--data-only` restores of tables
 * with FK constraints so rows can load in any order without transient FK
 * violations, matching pg_restore's own documented recommendation for
 * this combination. Requires the same `hexyrn_backup`-style
 * BYPASSRLS + DML role realPgDump needs - see that function's doc comment.
 */
export function realPgRestore(connectionString: string, pgRestorePath = process.env.PG_RESTORE_PATH ?? 'pg_restore') {
  return async (dumpPath: string): Promise<void> => {
    try {
      await execFileAsync(pgRestorePath, ['--data-only', '--disable-triggers', '--no-owner', '--dbname', connectionString, dumpPath]);
    } catch (err) {
      throw new Error(
        `pg_restore failed (looked for "${pgRestorePath}" - override with PG_RESTORE_PATH if it's not on PATH): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
