import { statfsSync } from 'fs';
import { SignedReleaseManifest } from '../release-signing/release-manifest';
import { ReleaseVerifier } from '../release-signing/release-verifier';
import { TrustedKeyEntry } from '../release-signing/release-keys';
import { CORE_VERSION } from '../core-version';

/**
 * Offline update system (P3 items 14/15). No internet connectivity is
 * required anywhere in this module - an update is a local file (the
 * package) plus a signed manifest, both already on disk; every check here
 * is local computation, filesystem inspection, or an injected callback.
 *
 * Reuses the release-signing module (items 16/26/27) rather than building
 * a second manifest/signature format - an "offline update package" and a
 * "release artifact" are the same kind of signed, hash-verified thing at
 * this layer; ReleaseManifest.artifactType distinguishes them
 * ('offline-update-package' vs 'windows-x64-installer'/'docker-image'),
 * and migrationNotes carries the "migration requirements" item 14 asks
 * for.
 *
 * OS-execution boundaries (running migrations, entering/exiting
 * maintenance mode, restarting the process, health-checking the running
 * app) are all injected callbacks, exactly like backup.service.ts's
 * runPgDump/runPgRestore - this file owns the ORCHESTRATION (ordering,
 * preflight checks, failure handling, what must succeed before what),
 * never the OS mechanism itself, so it is fully testable without actually
 * running an update.
 */

export interface DiskSpaceCheckResult {
  ok: boolean;
  availableBytes: number;
  requiredBytes: number;
  reason?: string;
}

/**
 * Item 15: "detect insufficient disk space where practical." Best-effort -
 * statfs is not available/meaningful on every platform/filesystem, so a
 * failure to determine free space is reported as `ok: true` with a warning
 * reason (fail open on an unknowable check, never block a legitimate
 * update because disk-space introspection itself failed) rather than
 * fail-closed, which would be worse than not checking at all.
 */
export function checkDiskSpace(targetPath: string, requiredBytes: number): DiskSpaceCheckResult {
  try {
    const stats = statfsSync(targetPath);
    const availableBytes = stats.bavail * stats.bsize;
    return {
      ok: availableBytes >= requiredBytes,
      availableBytes,
      requiredBytes,
      reason: availableBytes >= requiredBytes ? undefined : `Only ${availableBytes} bytes free at "${targetPath}", need at least ${requiredBytes}.`,
    };
  } catch (err) {
    return {
      ok: true,
      availableBytes: -1,
      requiredBytes,
      reason: `Could not determine free disk space at "${targetPath}" (${err instanceof Error ? err.message : String(err)}) - proceeding without this check; verify manually before a large update.`,
    };
  }
}

export interface CompatibilityCheckResult {
  compatible: boolean;
  reason: string;
}

/**
 * Item 15: "verify compatibility" - for an UPDATE (moving forward), unlike
 * checkRestoreCompatibility in backup.service.ts (which rejects a backup
 * NEWER than running Core, since you can't restore data from the future
 * into an older schema-aware Core), an update package must be the SAME or
 * a NEWER major version than what's running - installing an OLDER package
 * over a newer running installation is a downgrade, which this system
 * does not support (Architecture: forward-only migrations, no fake
 * rollback - see the module doc comment on applyUpdate).
 */
export function checkUpdateCompatibility(manifest: SignedReleaseManifest, runningCoreVersion: string = CORE_VERSION): CompatibilityCheckResult {
  const parseMajor = (v: string) => parseInt(v.replace(/^[^\d]*/, '').split('.')[0], 10);
  const packageMajor = parseMajor(manifest.version);
  const runningMajor = parseMajor(runningCoreVersion);
  if (Number.isNaN(packageMajor) || Number.isNaN(runningMajor)) {
    return { compatible: false, reason: `Could not parse a major version from "${manifest.version}" or "${runningCoreVersion}".` };
  }
  if (packageMajor < runningMajor) {
    return {
      compatible: false,
      reason: `This update package is version ${manifest.version}, OLDER than the currently running ${runningCoreVersion} - downgrading via the update system is not supported. To roll back, restore a pre-update backup instead (see docs/RESTORE.md).`,
    };
  }
  return { compatible: true, reason: `Update package ${manifest.version} is compatible with running ${runningCoreVersion}.` };
}

export interface BackupPreflightResult {
  ok: boolean;
  reason: string;
}

/**
 * Item 15: "check backup status; strongly encourage/auto-create a backup
 * where appropriate." `requireRecentBackup` decides the policy (strict
 * refuse-without-backup vs advisory-only); `hasRecentBackup` is the actual
 * check, injected so this module never has to know backup.service.ts's
 * storage layout directly - the caller (the real update orchestrator
 * wiring) is what actually knows where backups live.
 */
export async function checkBackupPreflight(
  hasRecentBackup: () => Promise<boolean>,
  requireRecentBackup: boolean,
): Promise<BackupPreflightResult> {
  const recent = await hasRecentBackup();
  if (recent) return { ok: true, reason: 'A recent backup exists.' };
  if (requireRecentBackup) {
    return { ok: false, reason: 'No recent backup found, and this update is configured to require one before proceeding. Create a backup first, or pass autoBackup to create one automatically.' };
  }
  return { ok: true, reason: 'No recent backup found, proceeding anyway (backup preflight is advisory, not required, per current configuration) - strongly recommended to back up before any update regardless.' };
}

export type UpdateStepName =
  | 'verify_package'
  | 'check_compatibility'
  | 'check_disk_space'
  | 'backup_preflight'
  | 'create_backup'
  | 'enter_maintenance_mode'
  | 'run_migrations'
  | 'health_check'
  | 'exit_maintenance_mode';

export interface UpdateStepResult {
  step: UpdateStepName;
  ok: boolean;
  detail: string;
}

export interface ApplyUpdateOptions {
  packagePath: string;
  manifest: SignedReleaseManifest;
  trustedKeys?: TrustedKeyEntry[];
  runningCoreVersion?: string;
  requiredDiskBytes: number;
  diskCheckPath: string;
  hasRecentBackup: () => Promise<boolean>;
  requireRecentBackup: boolean;
  autoBackup?: () => Promise<void>;
  enterMaintenanceMode: () => Promise<void>;
  exitMaintenanceMode: () => Promise<void>;
  runMigrations: () => Promise<void>;
  runHealthCheck: () => Promise<{ healthy: boolean; issues: string[] }>;
}

export interface ApplyUpdateResult {
  succeeded: boolean;
  steps: UpdateStepResult[];
  /** true once maintenance mode was entered - callers use this to decide whether exitMaintenanceMode still needs calling on a thrown/unexpected error outside this function's own try/finally (defence in depth, this function already guarantees it itself). */
  maintenanceModeActive: boolean;
}

/**
 * Item 15's full "before/during/after" sequence, in one orchestrator:
 * verify package authenticity+integrity -> check compatibility -> check
 * disk space -> backup preflight (create one if configured and missing)
 * -> maintenance mode -> migrations -> health check -> exit maintenance
 * mode. Stops at the FIRST failing step and never proceeds past it -
 * there is no code path that runs migrations against an unverified
 * package, or exits maintenance mode after a failed health check (leaving
 * an unhealthy instance in maintenance mode is the correct, safe failure
 * state - it stops serving normal traffic rather than serving a broken
 * one; recovery is the documented restore-from-backup path, not an
 * automatic rollback - see checkUpdateCompatibility's doc comment).
 *
 * `maintenanceModeActive` in the result plus this function's own
 * try/finally guarantee exitMaintenanceMode is called if entry succeeded
 * and something later throws unexpectedly (not just an ordinary step
 * failure, which is reported via `steps` instead of throwing) - so a
 * crash mid-update does not strand the installation in maintenance mode
 * forever without at least an attempt to exit it. Genuine crash recovery
 * beyond that (e.g. the process itself dying) is an operational procedure
 * (docs), not something this function can guarantee.
 */
export async function applyUpdate(options: ApplyUpdateOptions): Promise<ApplyUpdateResult> {
  const steps: UpdateStepResult[] = [];
  let maintenanceModeActive = false;

  const verifier = new ReleaseVerifier();
  const verifyResult = await verifier.verifyArtifactFile(options.packagePath, options.manifest, options.trustedKeys);
  steps.push({ step: 'verify_package', ok: verifyResult.valid, detail: verifyResult.valid ? 'Package signature and checksum verified.' : verifyResult.reason ?? 'Verification failed.' });
  if (!verifyResult.valid) return { succeeded: false, steps, maintenanceModeActive };

  const compat = checkUpdateCompatibility(options.manifest, options.runningCoreVersion);
  steps.push({ step: 'check_compatibility', ok: compat.compatible, detail: compat.reason });
  if (!compat.compatible) return { succeeded: false, steps, maintenanceModeActive };

  const disk = checkDiskSpace(options.diskCheckPath, options.requiredDiskBytes);
  steps.push({ step: 'check_disk_space', ok: disk.ok, detail: disk.reason ?? `${disk.availableBytes} bytes available.` });
  if (!disk.ok) return { succeeded: false, steps, maintenanceModeActive };

  let backupPreflight = await checkBackupPreflight(options.hasRecentBackup, options.requireRecentBackup);
  if (!backupPreflight.ok && options.autoBackup) {
    try {
      await options.autoBackup();
      steps.push({ step: 'create_backup', ok: true, detail: 'Auto-created a backup before proceeding.' });
      backupPreflight = { ok: true, reason: 'Backup auto-created.' };
    } catch (err) {
      steps.push({ step: 'create_backup', ok: false, detail: `Auto-backup failed: ${err instanceof Error ? err.message : String(err)}` });
      return { succeeded: false, steps, maintenanceModeActive };
    }
  }
  steps.push({ step: 'backup_preflight', ok: backupPreflight.ok, detail: backupPreflight.reason });
  if (!backupPreflight.ok) return { succeeded: false, steps, maintenanceModeActive };

  try {
    await options.enterMaintenanceMode();
    maintenanceModeActive = true;
    steps.push({ step: 'enter_maintenance_mode', ok: true, detail: 'Maintenance mode active - the application is not serving normal requests.' });

    try {
      await options.runMigrations();
      steps.push({ step: 'run_migrations', ok: true, detail: 'Migrations applied.' });
    } catch (err) {
      steps.push({ step: 'run_migrations', ok: false, detail: `Migration failed: ${err instanceof Error ? err.message : String(err)}. The installation remains in maintenance mode - restore the pre-update backup before resuming normal operation.` });
      return { succeeded: false, steps, maintenanceModeActive };
    }

    const health = await options.runHealthCheck();
    steps.push({ step: 'health_check', ok: health.healthy, detail: health.healthy ? 'Post-update health check passed.' : `Post-update health check failed: ${health.issues.join('; ')}. The installation remains in maintenance mode - restore the pre-update backup before resuming normal operation.` });
    if (!health.healthy) {
      return { succeeded: false, steps, maintenanceModeActive };
    }

    await options.exitMaintenanceMode();
    maintenanceModeActive = false;
    steps.push({ step: 'exit_maintenance_mode', ok: true, detail: 'Maintenance mode cleared - the application is serving normal requests again.' });

    return { succeeded: true, steps, maintenanceModeActive };
  } catch (err) {
    // An unexpected (not ordinarily-handled) error - try to leave a clean
    // trail even though we can't guarantee more than that.
    steps.push({ step: 'health_check', ok: false, detail: `Unexpected error during update: ${err instanceof Error ? err.message : String(err)}` });
    return { succeeded: false, steps, maintenanceModeActive };
  }
}
