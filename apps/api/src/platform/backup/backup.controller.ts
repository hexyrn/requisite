import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { promises as fs } from 'fs';
import { join } from 'path';
import { withOrgContext } from '../../db/org-context';
import { getPool } from '../../db/pool';
import { RequirePermission } from '../../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../../rbac/permissions';
import { AuditService } from '../../audit/audit.service';
import { logStructured } from '../../logging/logger';
import {
  createBackup,
  verifyBackupIntegrity,
  restoreBackup,
  realPgDump,
  realPgRestore,
} from './backup.service';

/**
 * Backup/restore admin endpoints (P3 item 9-13, HTTP surface). The
 * underlying mechanism (backup.service.ts) was implemented and tested
 * first, WITHOUT an HTTP surface - the same gap pattern already found and
 * closed for licence administration; closed here identically.
 *
 * Installation-level (a backup captures the whole installation's
 * database, not one organisation's data - Architecture §7), gated by
 * ORGANISATION_MANAGE, same seam SmtpController/HealthDiagnosticsController
 * already use for installation-adjacent admin surfaces in a v1
 * one-organisation-per-installation deployment.
 *
 * Every destination path is confined under HEXYRN_BACKUP_DIR - a caller
 * can never supply an arbitrary filesystem path (path traversal
 * protection, same discipline as StorageProvider's key validation).
 */
@Controller('api/v1/backup')
export class BackupController {
  constructor(private readonly audit: AuditService) {}

  private backupsRoot(): string {
    return process.env.HEXYRN_BACKUP_DIR ?? './backups';
  }

  /**
   * A REAL production bug, found and fixed this phase (not merely a
   * naming cleanup): this previously fell back to MIGRATE_DATABASE_URL
   * (the `hexyrn` schema-owner role) when BACKUP_DATABASE_URL wasn't set.
   * `hexyrn` is deliberately NOT BYPASSRLS (see docker/postgres-init/
   * 01-app-role.sh) - and FORCE ROW LEVEL SECURITY applies even to the
   * table OWNER (confirmed by the real pg_dump/pg_restore acceptance
   * test, P3 item 13/14 - see P3-ENVIRONMENT-VERIFICATION.md), so a
   * backup attempted with the migration role would have failed in
   * production with the exact same "query would be affected by row-level
   * security policy" error that motivated creating `hexyrn_backup` in the
   * first place. BACKUP_DATABASE_URL (the `hexyrn_backup` role's
   * connection string) is now REQUIRED with no silent fallback to a
   * role that cannot actually do the job.
   */
  private dumpConnectionString(): string {
    const cs = process.env.BACKUP_DATABASE_URL;
    if (!cs) {
      throw new BadRequestException(
        'Backups are not set up correctly on this installation. Run Repair from Windows Settings > Apps > Requisite, or contact support.',
      );
    }
    return cs;
  }

  private storageRoot(): string {
    return process.env.LOCAL_STORAGE_PATH ?? './storage';
  }

  /** "Backup Now" (item 9). */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Post()
  async createBackupNow(@Req() req: FastifyRequest) {
    const organisationId = (req as any).currentOrganisationId;
    const actor = (req as any).currentUser;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destinationDir = join(this.backupsRoot(), timestamp);

    const result = await createBackup({
      destinationDir,
      storageRootDir: this.storageRoot(),
      pool: getPool(),
      runPgDump: realPgDump(this.dumpConnectionString()),
    });

    logStructured({
      event: 'backup.created',
      level: 'info',
      userRef: actor?.id,
      context: { backupDir: result.backupDir },
    });
    await withOrgContext(organisationId, (db) =>
      this.audit.record(db, {
        organisationId,
        eventType: 'config.changed',
        actorUserAccountId: actor?.id,
        entityType: 'backup',
        entityRef: timestamp,
      }),
    );

    return { backupId: timestamp, manifest: result.manifest };
  }

  /** List backups (item 9: "last successful backup," backup health at a glance). */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Get()
  async listBackups() {
    let entries: string[];
    try {
      entries = (await fs.readdir(this.backupsRoot(), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { backups: [] };
      throw err;
    }
    entries.sort().reverse(); // most recent first (ISO-8601-prefixed names sort chronologically)

    const backups = await Promise.all(
      entries.map(async (id) => {
        const integrity = await verifyBackupIntegrity(join(this.backupsRoot(), id));
        return {
          backupId: id,
          valid: integrity.valid,
          issues: integrity.issues,
          createdAt: integrity.manifest?.createdAt ?? null,
          coreVersion: integrity.manifest?.coreVersion ?? null,
        };
      }),
    );
    return { backups };
  }

  /** Item 9: "restore guidance/status" - a single backup's full integrity detail. */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Get(':id')
  async getBackup(@Param('id') id: string) {
    assertSafeBackupId(id);
    const integrity = await verifyBackupIntegrity(join(this.backupsRoot(), id));
    if (!integrity.manifest) throw new NotFoundException(`Backup "${id}" not found or unreadable.`);
    return integrity;
  }

  /**
   * Item 12: the destructive restore, gated behind an explicit
   * confirmation the caller must set (mirrors restoreBackup()'s own
   * refuse-without-confirmation guard - belt and braces, the HTTP layer
   * requires it too so a client bug can't accidentally omit it and still
   * trigger a destructive restore via some future default).
   */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Post(':id/restore')
  async restore(
    @Req() req: FastifyRequest,
    @Param('id') id: string,
    @Body() body: { confirmed?: boolean },
  ) {
    assertSafeBackupId(id);
    if (body.confirmed !== true) {
      throw new BadRequestException(
        'Restoring a backup is destructive and overwrites the current database and files. Set confirmed: true to proceed.',
      );
    }
    const organisationId = (req as any).currentOrganisationId;
    const actor = (req as any).currentUser;

    const result = await restoreBackup({
      backupDir: join(this.backupsRoot(), id),
      storageRootDir: this.storageRoot(),
      runPgRestore: realPgRestore(this.dumpConnectionString()),
      confirmed: true,
    });

    logStructured({
      event: 'backup.restored',
      level: 'warn',
      userRef: actor?.id,
      context: { backupId: id, filesRestored: result.filesRestored },
    });
    await withOrgContext(organisationId, (db) =>
      this.audit.record(db, {
        organisationId,
        eventType: 'config.changed',
        actorUserAccountId: actor?.id,
        entityType: 'backup_restore',
        entityRef: id,
      }),
    );

    return { restored: true, manifest: result.manifest, filesRestored: result.filesRestored };
  }
}

/** Backup ids are our own generated ISO-timestamp-derived directory names - reject anything else outright rather than letting a caller-supplied id reach a filesystem path. */
function assertSafeBackupId(id: string): void {
  if (!/^[0-9A-Za-z_-]+$/.test(id)) {
    throw new BadRequestException('Invalid backup id.');
  }
}
