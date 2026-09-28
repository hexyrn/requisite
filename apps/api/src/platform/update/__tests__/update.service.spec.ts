import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  checkDiskSpace,
  checkUpdateCompatibility,
  checkBackupPreflight,
  applyUpdate,
  ApplyUpdateOptions,
} from '../update.service';
import { signReleaseManifest, buildReleaseManifest } from '../../release-signing/release-signer';
import {
  TEST_RELEASE_KEY_ID_1,
  TEST_RELEASE_PRIVATE_KEY_1_PEM,
} from '../../release-signing/release-keys';
import { ReleaseManifest } from '../../release-signing/release-manifest';

async function mkTmpFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'hexyrn-update-pkg-'));
  const path = join(dir, 'update-package.bin');
  await fs.writeFile(path, content);
  return path;
}

const BASE_FIELDS: Omit<ReleaseManifest, 'artifactSha256' | 'artifactSizeBytes' | 'builtAt'> = {
  formatVersion: 1,
  productId: 'hexyrn-core',
  version: '1.1.0',
  requiresCoreVersion: '1.1.0',
  artifactType: 'offline-update-package',
  migrationNotes: 'Adds one new table; no destructive changes.',
};

describe('Update system (P3 items 14/15)', () => {
  describe('checkDiskSpace', () => {
    it('reports ok: true when plenty of space is available at a real path', () => {
      const result = checkDiskSpace(tmpdir(), 1); // 1 byte required - always satisfiable
      expect(result.ok).toBe(true);
      expect(result.availableBytes).toBeGreaterThan(0);
    });

    it('reports ok: false when the requirement exceeds any real disk', () => {
      const result = checkDiskSpace(tmpdir(), Number.MAX_SAFE_INTEGER);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/need at least/i);
    });

    it('fails open (ok: true, with an explanatory reason) if the path does not exist rather than blocking the update', () => {
      const result = checkDiskSpace('/definitely/does/not/exist/anywhere', 1000);
      expect(result.ok).toBe(true);
      expect(result.availableBytes).toBe(-1);
      expect(result.reason).toMatch(/could not determine/i);
    });
  });

  describe('checkUpdateCompatibility', () => {
    const manifest = signReleaseManifest(
      {
        ...BASE_FIELDS,
        artifactSha256: 'a'.repeat(64),
        artifactSizeBytes: 1,
        builtAt: new Date().toISOString(),
      },
      TEST_RELEASE_KEY_ID_1,
      TEST_RELEASE_PRIVATE_KEY_1_PEM,
    );

    it('accepts an update package with the same major version as running Core', () => {
      expect(checkUpdateCompatibility({ ...manifest, version: '1.0.5' }, '1.0.0').compatible).toBe(
        true,
      );
    });

    it('accepts an update package with a NEWER major version than running Core (the normal forward-update case)', () => {
      expect(checkUpdateCompatibility({ ...manifest, version: '2.0.0' }, '1.5.0').compatible).toBe(
        true,
      );
    });

    it('refuses an update package OLDER than the currently running version - no downgrade via the update system', () => {
      const result = checkUpdateCompatibility({ ...manifest, version: '1.0.0' }, '2.0.0');
      expect(result.compatible).toBe(false);
      expect(result.reason).toMatch(/older/i);
      expect(result.reason).toMatch(/restore/i); // points at the actual rollback mechanism
    });
  });

  describe('checkBackupPreflight', () => {
    it('passes when a recent backup exists, regardless of the required flag', async () => {
      const result = await checkBackupPreflight(async () => true, true);
      expect(result.ok).toBe(true);
    });

    it('fails when no recent backup exists and one is required', async () => {
      const result = await checkBackupPreflight(async () => false, true);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/require/i);
    });

    it('passes (advisory only) when no recent backup exists but one is not strictly required', async () => {
      const result = await checkBackupPreflight(async () => false, false);
      expect(result.ok).toBe(true);
      expect(result.reason).toMatch(/strongly recommended/i);
    });
  });

  describe('applyUpdate - full orchestration', () => {
    async function signedPackage(overrides: Partial<ReleaseManifest> = {}) {
      const path = await mkTmpFile('FAKE UPDATE PACKAGE BYTES');
      const manifest = await buildReleaseManifest(path, { ...BASE_FIELDS, ...overrides });
      const signed = signReleaseManifest(
        manifest,
        TEST_RELEASE_KEY_ID_1,
        TEST_RELEASE_PRIVATE_KEY_1_PEM,
      );
      return { path, signed };
    }

    function baseOptions(
      overrides: Partial<ApplyUpdateOptions> = {},
    ): Omit<ApplyUpdateOptions, 'packagePath' | 'manifest'> {
      const calls: string[] = [];
      return {
        requiredDiskBytes: 1,
        diskCheckPath: tmpdir(),
        hasRecentBackup: async () => true,
        requireRecentBackup: true,
        enterMaintenanceMode: async () => {
          calls.push('enter');
        },
        exitMaintenanceMode: async () => {
          calls.push('exit');
        },
        runMigrations: async () => {
          calls.push('migrate');
        },
        runHealthCheck: async () => ({ healthy: true, issues: [] }),
        ...overrides,
      } as Omit<ApplyUpdateOptions, 'packagePath' | 'manifest'>;
    }

    it('runs the full happy path in order and succeeds', async () => {
      const { path, signed } = await signedPackage();
      const order: string[] = [];
      const result = await applyUpdate({
        packagePath: path,
        manifest: signed,
        runningCoreVersion: '1.0.0',
        ...baseOptions({
          enterMaintenanceMode: async () => {
            order.push('enter');
          },
          runMigrations: async () => {
            order.push('migrate');
          },
          exitMaintenanceMode: async () => {
            order.push('exit');
          },
          runHealthCheck: async () => {
            order.push('health');
            return { healthy: true, issues: [] };
          },
        }),
      });

      expect(result.succeeded).toBe(true);
      expect(result.maintenanceModeActive).toBe(false); // cleared on success
      expect(order).toEqual(['enter', 'migrate', 'health', 'exit']);
      expect(result.steps.map((s) => s.step)).toEqual([
        'verify_package',
        'check_compatibility',
        'check_disk_space',
        'backup_preflight',
        'enter_maintenance_mode',
        'run_migrations',
        'health_check',
        'exit_maintenance_mode',
      ]);
      expect(result.steps.every((s) => s.ok)).toBe(true);
    });

    it('refuses an update whose package fails signature verification, before touching ANYTHING else', async () => {
      const { path, signed } = await signedPackage();
      // Tamper with the artifact bytes after signing.
      await fs.writeFile(path, 'TAMPERED PACKAGE CONTENT DIFFERENT');

      let migrationsRan = false;
      const result = await applyUpdate({
        packagePath: path,
        manifest: signed,
        runningCoreVersion: '1.0.0',
        ...baseOptions({
          runMigrations: async () => {
            migrationsRan = true;
          },
        }),
      });

      expect(result.succeeded).toBe(false);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].step).toBe('verify_package');
      expect(migrationsRan).toBe(false);
      expect(result.maintenanceModeActive).toBe(false);
    });

    it('refuses an incompatible (older) package before entering maintenance mode', async () => {
      const { path, signed } = await signedPackage({ version: '0.9.0' });
      let maintenanceEntered = false;
      const result = await applyUpdate({
        packagePath: path,
        manifest: signed,
        runningCoreVersion: '1.0.0',
        ...baseOptions({
          enterMaintenanceMode: async () => {
            maintenanceEntered = true;
          },
        }),
      });
      expect(result.succeeded).toBe(false);
      expect(result.steps.map((s) => s.step)).toEqual(['verify_package', 'check_compatibility']);
      expect(maintenanceEntered).toBe(false);
    });

    it('refuses when disk space is insufficient, before backup/maintenance-mode steps', async () => {
      const { path, signed } = await signedPackage();
      const result = await applyUpdate({
        packagePath: path,
        manifest: signed,
        runningCoreVersion: '1.0.0',
        ...baseOptions({ requiredDiskBytes: Number.MAX_SAFE_INTEGER }),
      });
      expect(result.succeeded).toBe(false);
      expect(result.steps.map((s) => s.step)).toEqual([
        'verify_package',
        'check_compatibility',
        'check_disk_space',
      ]);
    });

    it('auto-creates a backup when none exists and autoBackup is configured, then proceeds', async () => {
      const { path, signed } = await signedPackage();
      let autoBackupCalled = false;
      const result = await applyUpdate({
        packagePath: path,
        manifest: signed,
        runningCoreVersion: '1.0.0',
        ...baseOptions({
          hasRecentBackup: async () => false,
          requireRecentBackup: true,
          autoBackup: async () => {
            autoBackupCalled = true;
          },
        }),
      });
      expect(autoBackupCalled).toBe(true);
      expect(result.succeeded).toBe(true);
      expect(result.steps.some((s) => s.step === 'create_backup' && s.ok)).toBe(true);
    });

    it('refuses when no backup exists, one is required, and no autoBackup is configured', async () => {
      const { path, signed } = await signedPackage();
      const result = await applyUpdate({
        packagePath: path,
        manifest: signed,
        runningCoreVersion: '1.0.0',
        ...baseOptions({
          hasRecentBackup: async () => false,
          requireRecentBackup: true,
          autoBackup: undefined,
        }),
      });
      expect(result.succeeded).toBe(false);
      expect(result.steps.at(-1)?.step).toBe('backup_preflight');
    });

    it('a migration failure leaves the installation in maintenance mode (never exits after failure) and never calls the health check', async () => {
      const { path, signed } = await signedPackage();
      let healthCheckCalled = false;
      const result = await applyUpdate({
        packagePath: path,
        manifest: signed,
        runningCoreVersion: '1.0.0',
        ...baseOptions({
          runMigrations: async () => {
            throw new Error('migration exploded: constraint violation');
          },
          runHealthCheck: async () => {
            healthCheckCalled = true;
            return { healthy: true, issues: [] };
          },
        }),
      });

      expect(result.succeeded).toBe(false);
      expect(result.maintenanceModeActive).toBe(true); // NOT cleared - correct fail-safe state
      expect(healthCheckCalled).toBe(false);
      const migrationStep = result.steps.find((s) => s.step === 'run_migrations');
      expect(migrationStep?.ok).toBe(false);
      expect(migrationStep?.detail).toMatch(/migration exploded/);
      expect(migrationStep?.detail).toMatch(/remains in maintenance mode/i);
      expect(result.steps.some((s) => s.step === 'exit_maintenance_mode')).toBe(false);
    });

    it('a failed post-update health check also leaves the installation in maintenance mode', async () => {
      const { path, signed } = await signedPackage();
      const result = await applyUpdate({
        packagePath: path,
        manifest: signed,
        runningCoreVersion: '1.0.0',
        ...baseOptions({
          runHealthCheck: async () => ({ healthy: false, issues: ['database connectivity lost'] }),
        }),
      });

      expect(result.succeeded).toBe(false);
      expect(result.maintenanceModeActive).toBe(true);
      const healthStep = result.steps.find((s) => s.step === 'health_check');
      expect(healthStep?.ok).toBe(false);
      expect(healthStep?.detail).toMatch(/database connectivity lost/);
      expect(result.steps.some((s) => s.step === 'exit_maintenance_mode')).toBe(false);
    });
  });
});
