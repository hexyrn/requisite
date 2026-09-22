import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Pool } from 'pg';
import {
  createBackup,
  verifyBackupIntegrity,
  checkRestoreCompatibility,
  applyRetentionPolicy,
  restoreBackup,
  BackupManifest,
} from '../backup.service';

/**
 * These tests do NOT require the real pg_dump/pg_restore binaries - the
 * dump/restore steps are injected fake functions that write/read a plain
 * marker file, exactly matching how a real CreateBackupOptions.runPgDump
 * would be wired in production (see backup.service.ts's realPgDump/
 * realPgRestore for the actual child_process invocation, which is NOT
 * exercised here - see the module's doc comment on why that could not be
 * verified in this sandbox). Everything genuinely testable without the
 * binaries - manifest generation, checksums, integrity verification,
 * tamper detection, retention, version compatibility, and the full
 * orchestration/guard logic in restoreBackup - is exercised for real
 * against a real temp filesystem and (for the installed-apps query) a real
 * Postgres connection.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

async function mkTmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

const fakePgDump = (content: string) => async (outputPath: string) => {
  await fs.writeFile(outputPath, content);
};

describeIfDb('BackupService (P3 items 9-13)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('createBackup', () => {
    it('produces a manifest with a real checksum of the (fake) database dump', async () => {
      const dest = await mkTmpDir('hexyrn-backup-');
      const storageDir = await mkTmpDir('hexyrn-storage-empty-');

      const { manifest } = await createBackup({
        destinationDir: dest,
        storageRootDir: storageDir,
        pool,
        runPgDump: fakePgDump('FAKE DUMP CONTENT'),
      });

      expect(manifest.formatVersion).toBe(1);
      expect(manifest.database.filename).toBe('database.dump');
      expect(manifest.database.sha256).toHaveLength(64);
      expect(manifest.files).toBeNull(); // no files were present to back up
      expect(manifest.consistencyNote).toMatch(/snapshot/i);

      const onDisk = await fs.readFile(join(dest, 'manifest.json'), 'utf8');
      expect(JSON.parse(onDisk)).toEqual(manifest);
    });

    it('includes uploaded files in the backup with a real directory checksum', async () => {
      const dest = await mkTmpDir('hexyrn-backup-');
      const storageDir = await mkTmpDir('hexyrn-storage-');
      await fs.writeFile(join(storageDir, 'file-a'), 'hello');
      await fs.writeFile(join(storageDir, 'file-b'), 'world');

      const { manifest } = await createBackup({
        destinationDir: dest,
        storageRootDir: storageDir,
        pool,
        runPgDump: fakePgDump('FAKE DUMP'),
      });

      expect(manifest.files).not.toBeNull();
      expect(manifest.files!.includedFileCount).toBe(2);

      const copiedA = await fs.readFile(join(dest, 'files', 'file-a'), 'utf8');
      expect(copiedA).toBe('hello');
    });
  });

  describe('verifyBackupIntegrity', () => {
    it('reports valid: true for a fresh, untampered backup', async () => {
      const dest = await mkTmpDir('hexyrn-backup-');
      const storageDir = await mkTmpDir('hexyrn-storage-');
      await fs.writeFile(join(storageDir, 'file-a'), 'hello');

      await createBackup({ destinationDir: dest, storageRootDir: storageDir, pool, runPgDump: fakePgDump('DUMP') });
      const result = await verifyBackupIntegrity(dest);

      expect(result.valid).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('detects a tampered database dump file', async () => {
      const dest = await mkTmpDir('hexyrn-backup-');
      const storageDir = await mkTmpDir('hexyrn-storage-empty-');
      await createBackup({ destinationDir: dest, storageRootDir: storageDir, pool, runPgDump: fakePgDump('ORIGINAL') });

      await fs.writeFile(join(dest, 'database.dump'), 'TAMPERED CONTENT');

      const result = await verifyBackupIntegrity(dest);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => /checksum mismatch/i.test(i))).toBe(true);
    });

    it('detects a tampered/corrupted file in the files archive', async () => {
      const dest = await mkTmpDir('hexyrn-backup-');
      const storageDir = await mkTmpDir('hexyrn-storage-');
      await fs.writeFile(join(storageDir, 'file-a'), 'original');
      await createBackup({ destinationDir: dest, storageRootDir: storageDir, pool, runPgDump: fakePgDump('DUMP') });

      await fs.writeFile(join(dest, 'files', 'file-a'), 'tampered');

      const result = await verifyBackupIntegrity(dest);
      expect(result.valid).toBe(false);
      expect(result.issues.some((i) => /files archive checksum mismatch/i.test(i))).toBe(true);
    });

    it('fails closed (valid: false) when manifest.json is missing entirely', async () => {
      const dest = await mkTmpDir('hexyrn-backup-empty-');
      const result = await verifyBackupIntegrity(dest);
      expect(result.valid).toBe(false);
      expect(result.manifest).toBeNull();
    });
  });

  describe('checkRestoreCompatibility', () => {
    const baseManifest: BackupManifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      coreVersion: '0.1.0-p1',
      installedApps: [],
      database: { filename: 'database.dump', sha256: 'x', sizeBytes: 1 },
      files: null,
      consistencyNote: 'n/a',
    };

    it('is compatible when backup and running major versions match', () => {
      const result = checkRestoreCompatibility(baseManifest, '0.1.0-p1');
      expect(result.compatible).toBe(true);
    });

    it('is compatible when the backup is an older major version than running Core', () => {
      const older = { ...baseManifest, coreVersion: '0.1.0-p1' };
      const result = checkRestoreCompatibility(older, '1.2.0');
      expect(result.compatible).toBe(true);
    });

    it('refuses a backup from a NEWER Core major version than what is currently running', () => {
      const newer = { ...baseManifest, coreVersion: '2.0.0' };
      const result = checkRestoreCompatibility(newer, '1.0.0');
      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/newer/i);
    });
  });

  describe('applyRetentionPolicy', () => {
    it('keeps only the N most recent backup directories, deleting the rest', async () => {
      const root = await mkTmpDir('hexyrn-backups-root-');
      const names = ['2026-01-01T00-00-00', '2026-01-02T00-00-00', '2026-01-03T00-00-00', '2026-01-04T00-00-00'];
      for (const name of names) {
        await fs.mkdir(join(root, name));
      }

      const result = await applyRetentionPolicy(root, 2);
      expect(result.kept.sort()).toEqual(names.slice(-2).sort());
      expect(result.deleted.sort()).toEqual(names.slice(0, 2).sort());

      const remaining = await fs.readdir(root);
      expect(remaining.sort()).toEqual(names.slice(-2).sort());
    });

    it('refuses a retention policy that would keep zero backups', async () => {
      const root = await mkTmpDir('hexyrn-backups-root-');
      await expect(applyRetentionPolicy(root, 0)).rejects.toThrow(/at least 1/);
    });

    it('is a no-op on a directory that does not exist yet (no backups taken)', async () => {
      const result = await applyRetentionPolicy(join(tmpdir(), 'hexyrn-never-created-' + Date.now()), 5);
      expect(result).toEqual({ kept: [], deleted: [] });
    });
  });

  describe('restoreBackup', () => {
    it('refuses to run without explicit confirmation - no partial destructive action', async () => {
      const dest = await mkTmpDir('hexyrn-backup-');
      const storageDir = await mkTmpDir('hexyrn-storage-empty-');
      await createBackup({ destinationDir: dest, storageRootDir: storageDir, pool, runPgDump: fakePgDump('DUMP') });

      let restoreCalled = false;
      await expect(
        restoreBackup({
          backupDir: dest,
          storageRootDir: storageDir,
          runPgRestore: async () => {
            restoreCalled = true;
          },
          confirmed: false,
        }),
      ).rejects.toThrow(/explicit operator confirmation/);
      expect(restoreCalled).toBe(false);
    });

    it('refuses to restore a backup that fails integrity verification', async () => {
      const dest = await mkTmpDir('hexyrn-backup-');
      const storageDir = await mkTmpDir('hexyrn-storage-empty-');
      await createBackup({ destinationDir: dest, storageRootDir: storageDir, pool, runPgDump: fakePgDump('DUMP') });
      await fs.writeFile(join(dest, 'database.dump'), 'TAMPERED');

      await expect(
        restoreBackup({
          backupDir: dest,
          storageRootDir: storageDir,
          runPgRestore: async () => {},
          confirmed: true,
        }),
      ).rejects.toThrow(/integrity verification/);
    });

    it('runs the full real flow end to end: verify -> compatibility -> restore DB -> restore files', async () => {
      const dest = await mkTmpDir('hexyrn-backup-');
      const sourceStorageDir = await mkTmpDir('hexyrn-storage-source-');
      await fs.writeFile(join(sourceStorageDir, 'important-file'), 'original contents');

      await createBackup({ destinationDir: dest, storageRootDir: sourceStorageDir, pool, runPgDump: fakePgDump('DUMP') });

      // Simulate a "live" storage directory that has since diverged (item
      // 13's "alter/delete data" step) - restore must fully replace it.
      const liveStorageDir = await mkTmpDir('hexyrn-storage-live-');
      await fs.writeFile(join(liveStorageDir, 'important-file'), 'CORRUPTED BY LIVE CHANGES');
      await fs.writeFile(join(liveStorageDir, 'a-file-that-should-not-survive-restore'), 'x');

      let restoredDumpPath: string | null = null;
      const result = await restoreBackup({
        backupDir: dest,
        storageRootDir: liveStorageDir,
        runPgRestore: async (dumpPath) => {
          restoredDumpPath = dumpPath;
        },
        confirmed: true,
      });

      expect(restoredDumpPath).toContain('database.dump');
      expect(result.filesRestored).toBe(1);

      const restoredContent = await fs.readFile(join(liveStorageDir, 'important-file'), 'utf8');
      expect(restoredContent).toBe('original contents'); // proves restore, not a no-op

      const stillThere = await fs
        .access(join(liveStorageDir, 'a-file-that-should-not-survive-restore'))
        .then(() => true)
        .catch(() => false);
      expect(stillThere).toBe(false); // full-replace restore, not a merge
    });
  });
});
