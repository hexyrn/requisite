import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { withOrgContext } from '../../db/org-context';
import { getPool } from '../../db/pool';
import { setMaintenanceMode } from '../maintenance/maintenance-mode';
import { RequirePermission } from '../../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../../rbac/permissions';
import { AuditService } from '../../audit/audit.service';
import { logStructured } from '../../logging/logger';
import { runPendingMigrations } from '../../db/migrate';
import { CORE_VERSION } from '../core-version';
import { SignedReleaseManifest } from '../release-signing/release-manifest';
import { ReleaseVerifier } from '../release-signing/release-verifier';
import { checkUpdateCompatibility, checkDiskSpace, applyUpdate } from './update.service';
import { createBackup, realPgDump } from '../backup/backup.service';
import { HealthDiagnosticsService } from '../health/health-diagnostics.service';

/**
 * Update system admin endpoints (P3 items 14/15, HTTP surface) - the
 * underlying orchestration (update.service.ts) was implemented and tested
 * first, without an HTTP surface; closed here the same way
 * backup/licence's HTTP gaps were closed.
 *
 * "Check available" here means "verify this locally-placed offline update
 * package and report whether it's safe to apply" - there is no
 * internet-connected update-discovery mechanism (deliberately: P3 item 14
 * requires "no internet connection required," so a customer places the
 * package file on disk themselves, exactly the offline-update model the
 * architecture specifies).
 */
@Controller('api/v1/update')
export class UpdateController {
  constructor(
    private readonly audit: AuditService,
    private readonly health: HealthDiagnosticsService,
  ) {}

  /** Verifies a package WITHOUT applying anything - item 14: "current version, available update, compatibility, migration requirements" surfaced to the admin before they commit to anything. */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Post('check')
  async check(@Body() body: { packagePath: string; manifest: SignedReleaseManifest }) {
    const verifier = new ReleaseVerifier();
    const verification = await verifier.verifyArtifactFile(body.packagePath, body.manifest);
    const compatibility = checkUpdateCompatibility(body.manifest, CORE_VERSION);
    const disk = checkDiskSpace(process.cwd(), 200 * 1024 * 1024);

    return {
      runningCoreVersion: CORE_VERSION,
      packageVersion: body.manifest.version,
      packageAuthentic: verification.valid,
      packageAuthenticityDetail: verification.reason,
      compatible: compatibility.compatible,
      compatibilityDetail: compatibility.reason,
      migrationNotes: body.manifest.migrationNotes,
      diskSpaceOk: disk.ok,
      readyToApply: verification.valid && compatibility.compatible && disk.ok,
    };
  }

  /**
   * Applies a verified offline update package - the full item 15
   * before/during/after sequence (applyUpdate in update.service.ts),
   * wired to REAL migrations (runPendingMigrations, the same function the
   * CLI migration runner uses) and a REAL post-update health check
   * (HealthDiagnosticsService), not stubs. Maintenance mode is now
   * genuinely ENFORCED (platform/maintenance/maintenance-mode.ts, wired as
   * a global Fastify onRequest hook in main.ts): while active, every
   * state-changing request is rejected with 503 except an explicit
   * allowlist (health/diagnostics, the backup/update/support-bundle admin
   * endpoints themselves, login/logout) - see that module's doc comment
   * for the full design and why reads are still allowed through.
   */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Post('apply')
  async apply(
    @Req() req: FastifyRequest,
    @Body()
    body: {
      packagePath: string;
      manifest: SignedReleaseManifest;
      confirmed?: boolean;
      requireBackup?: boolean;
    },
  ) {
    if (body.confirmed !== true) {
      throw new BadRequestException(
        'Applying an update runs database migrations and cannot be safely undone in place. Set confirmed: true to proceed.',
      );
    }
    const organisationId = (req as any).currentOrganisationId;
    const actor = (req as any).currentUser;
    const pool = getPool();
    const migrateConnectionString = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!migrateConnectionString)
      throw new BadRequestException('MIGRATE_DATABASE_URL (or DATABASE_URL) is not configured.');
    const migratePool = new Pool({ connectionString: migrateConnectionString });
    // Deliberately a SEPARATE connection string from migrateConnectionString
    // (a real bug found and fixed this phase, same root cause as
    // BackupController's dumpConnectionString(): migrateConnectionString is
    // the `hexyrn` schema-owner role, which is NOT BYPASSRLS and cannot
    // pg_dump an RLS-forced database - see that controller's doc comment
    // for the confirmed real error and full reasoning).
    const backupConnectionString = process.env.BACKUP_DATABASE_URL;

    try {
      const result = await applyUpdate({
        packagePath: body.packagePath,
        manifest: body.manifest,
        runningCoreVersion: CORE_VERSION,
        requiredDiskBytes: 200 * 1024 * 1024,
        diskCheckPath: process.cwd(),
        hasRecentBackup: async () => false, // conservative default - no backup-freshness tracking yet, so always treated as "no recent backup" unless auto-backed-up below
        requireRecentBackup: body.requireBackup ?? true,
        autoBackup: async () => {
          if (!backupConnectionString) {
            throw new Error(
              'BACKUP_DATABASE_URL is not configured - cannot auto-backup before applying the update. Must point at the hexyrn_backup role (BYPASSRLS), see docker/postgres-init/01-app-role.sh.',
            );
          }
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          await createBackup({
            destinationDir: `${process.env.HEXYRN_BACKUP_DIR ?? './backups'}/${timestamp}-pre-update`,
            storageRootDir: process.env.LOCAL_STORAGE_PATH ?? './storage',
            pool,
            runPgDump: realPgDump(backupConnectionString),
          });
        },
        enterMaintenanceMode: () => setMaintenanceMode(pool, true),
        exitMaintenanceMode: () => setMaintenanceMode(pool, false),
        runMigrations: async () => {
          await runPendingMigrations(migratePool);
        },
        runHealthCheck: async () => {
          const snapshot = await withOrgContext(organisationId, (db) =>
            this.health.getSystemHealth(db, pool, organisationId),
          );
          return {
            healthy: snapshot.overallStatus !== 'error',
            issues: [snapshot.database, snapshot.migrations]
              .filter((c) => c.status === 'error')
              .map((c) => c.detail),
          };
        },
      });

      logStructured({
        event: 'update.applied',
        level: result.succeeded ? 'info' : 'error',
        userRef: actor?.id,
        context: { succeeded: result.succeeded, packageVersion: body.manifest.version },
      });
      await withOrgContext(organisationId, (db) =>
        this.audit.record(db, {
          organisationId,
          eventType: 'config.changed',
          actorUserAccountId: actor?.id,
          entityType: 'update',
          entityRef: body.manifest.version,
        }),
      );

      return result;
    } finally {
      await migratePool.end();
    }
  }
}
