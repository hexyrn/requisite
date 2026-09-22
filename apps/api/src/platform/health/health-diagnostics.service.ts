import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { Database } from '../../db/types';
import { CORE_VERSION, isCoreVersionCompatible } from '../core-version';
import { checkDiskSpace } from '../update/update.service';
import { SmtpConfigService } from '../smtp/smtp-config.service';

/**
 * System health + diagnostics (P3 items 19/20). Distinct surfaces per the
 * spec: HEALTH is "is everything currently working, with actionable
 * detail" (this file's getSystemHealth); DIAGNOSTICS is "what versions/
 * environment is this, for support purposes" (getDiagnostics) - related
 * but different audiences (an ops dashboard vs a support engineer asking
 * "what version are you on"). Both explicitly exclude secrets - neither
 * method ever reads a credential/secret column, matching
 * support-bundle.service.ts's "never SELECT a secret-bearing column"
 * discipline (the primary defense; there is no redaction layer needed
 * here because nothing sensitive is ever fetched in the first place).
 *
 * ACTIONABLE STATES, NOT JUST GREEN/RED: every check below returns a
 * `status` of 'ok' | 'warning' | 'error' PLUS a human-readable `detail`
 * explaining what, if anything, is wrong and (implicitly, via the detail
 * text) what to do about it - never a bare boolean an admin has to
 * separately go investigate.
 */

export type CheckStatus = 'ok' | 'warning' | 'error';

export interface HealthCheckResult {
  status: CheckStatus;
  detail: string;
}

export interface SystemHealth {
  generatedAt: string;
  overallStatus: CheckStatus;
  application: HealthCheckResult;
  database: HealthCheckResult;
  migrations: HealthCheckResult & { appliedCount: number };
  storage: HealthCheckResult & { availableBytes: number | null };
  backgroundJobs: HealthCheckResult & { failedCount: number };
  smtp: HealthCheckResult;
  installedApps: Array<{ appId: string; version: string; compatible: boolean; licensed: boolean }>;
  webhookDeliveryFailures: HealthCheckResult & { failedCount: number };
  integrationFailures: HealthCheckResult & { failedCount: number };
}

export interface DiagnosticsSnapshot {
  generatedAt: string;
  coreVersion: string;
  nodeVersion: string;
  platform: string;
  uptimeSeconds: number;
  installedApps: Array<{ appId: string; version: string; requiresCoreVersion: string; compatible: boolean }>;
  databaseVersion: string | null;
  storagePath: string;
  migrationCount: number;
}

const STORAGE_WARNING_THRESHOLD_BYTES = 500 * 1024 * 1024; // 500MB - matches a reasonable "you're about to run out" threshold for a small self-hosted install

function worstOf(...statuses: CheckStatus[]): CheckStatus {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

@Injectable()
export class HealthDiagnosticsService {
  constructor(private readonly smtpConfig: SmtpConfigService) {}

  async getSystemHealth(db: Kysely<Database>, pool: Pool, organisationId: string): Promise<SystemHealth> {
    const database = await this.checkDatabase(pool);
    const migrations = await this.checkMigrations(pool);
    const storage = this.checkStorage();
    const backgroundJobs = await this.checkBackgroundJobs(db);
    const smtp = await this.checkSmtp(pool);
    const installedApps = await this.checkInstalledApps(db, pool, organisationId);
    const webhookDeliveryFailures = await this.checkWebhookFailures(db);
    const integrationFailures = await this.checkIntegrationFailures(db);

    const application: HealthCheckResult = { status: 'ok', detail: `Hexyrn Core ${CORE_VERSION} is running.` };

    const overallStatus = worstOf(
      application.status,
      database.status,
      migrations.status,
      storage.status,
      backgroundJobs.status,
      smtp.status,
      webhookDeliveryFailures.status,
      integrationFailures.status,
    );

    return {
      generatedAt: new Date().toISOString(),
      overallStatus,
      application,
      database,
      migrations,
      storage,
      backgroundJobs,
      smtp,
      installedApps,
      webhookDeliveryFailures,
      integrationFailures,
    };
  }

  async getDiagnostics(db: Kysely<Database>, pool: Pool): Promise<DiagnosticsSnapshot> {
    const installedRows = await pool.query<{ app_id: string; version: string; requires_core_version: string }>(
      'SELECT app_id, version, requires_core_version FROM installed_applications ORDER BY app_id',
    );
    const migrationCountResult = await this.safeCount(pool, 'SELECT COUNT(*)::int AS n FROM schema_migrations');
    const dbVersionResult = await pool.query<{ version: string }>('SELECT version()').catch(() => null);

    return {
      generatedAt: new Date().toISOString(),
      coreVersion: CORE_VERSION,
      nodeVersion: process.version,
      platform: `${process.platform}-${process.arch}`,
      uptimeSeconds: Math.floor(process.uptime()),
      installedApps: installedRows.rows.map((r) => ({
        appId: r.app_id,
        version: r.version,
        requiresCoreVersion: r.requires_core_version,
        compatible: isCoreVersionCompatible(r.requires_core_version),
      })),
      databaseVersion: dbVersionResult?.rows[0]?.version ?? null,
      storagePath: process.env.LOCAL_STORAGE_PATH ?? './storage',
      migrationCount: migrationCountResult,
    };
  }

  private async checkDatabase(pool: Pool): Promise<HealthCheckResult> {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', detail: 'Database connection is healthy.' };
    } catch (err) {
      return { status: 'error', detail: `Database connection failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  private async checkMigrations(pool: Pool): Promise<HealthCheckResult & { appliedCount: number }> {
    const appliedCount = await this.safeCount(pool, 'SELECT COUNT(*)::int AS n FROM schema_migrations');
    if (appliedCount === 0) {
      return { status: 'warning', detail: 'No migrations recorded - either this is a genuinely fresh, unmigrated database, or migrations were applied through a path that does not update schema_migrations.', appliedCount };
    }
    return { status: 'ok', detail: `${appliedCount} migration(s) applied.`, appliedCount };
  }

  private checkStorage(): HealthCheckResult & { availableBytes: number | null } {
    const path = process.env.LOCAL_STORAGE_PATH ?? './storage';
    const result = checkDiskSpace(path, STORAGE_WARNING_THRESHOLD_BYTES);
    if (result.availableBytes === -1) {
      return { status: 'warning', detail: result.reason ?? 'Could not determine free disk space.', availableBytes: null };
    }
    if (!result.ok) {
      return { status: 'warning', detail: `Low disk space at "${path}": ${result.availableBytes} bytes available (recommend at least ${STORAGE_WARNING_THRESHOLD_BYTES} bytes free).`, availableBytes: result.availableBytes };
    }
    return { status: 'ok', detail: `${result.availableBytes} bytes available at "${path}".`, availableBytes: result.availableBytes };
  }

  private async checkBackgroundJobs(db: Kysely<Database>): Promise<HealthCheckResult & { failedCount: number }> {
    const rows = await db.selectFrom('scheduled_jobs').select(['job_type']).where('status', '=', 'failed').execute();
    const failedCount = rows.length;
    if (failedCount === 0) return { status: 'ok', detail: 'No failed background jobs.', failedCount };
    return { status: 'warning', detail: `${failedCount} failed background job(s) - see the support bundle for details.`, failedCount };
  }

  private async checkSmtp(pool: Pool): Promise<HealthCheckResult> {
    const config = await this.smtpConfig.getConfigForDisplay(pool);
    if (!config.configured) {
      return { status: 'warning', detail: 'SMTP is not configured - invitation/password-reset links must be shared manually with users. This is a supported, safe fallback, not a failure.' };
    }
    return { status: 'ok', detail: `SMTP configured (${config.host}:${config.port}). Use the "send test email" action to verify actual delivery - health checks do not open a live connection on every check.` };
  }

  private async checkInstalledApps(db: Kysely<Database>, pool: Pool, organisationId: string): Promise<SystemHealth['installedApps']> {
    const installedRows = await pool.query<{ app_id: string; version: string; requires_core_version: string }>('SELECT app_id, version, requires_core_version FROM installed_applications ORDER BY app_id');
    const licenseRows = await db.selectFrom('application_licenses').select(['app_id']).where('organisation_id', '=', organisationId).execute();
    const licensedAppIds = new Set(licenseRows.map((r) => r.app_id));
    return installedRows.rows.map((r) => ({
      appId: r.app_id,
      version: r.version,
      compatible: isCoreVersionCompatible(r.requires_core_version),
      licensed: licensedAppIds.has(r.app_id),
    }));
  }

  private async checkWebhookFailures(db: Kysely<Database>): Promise<HealthCheckResult & { failedCount: number }> {
    const rows = await db.selectFrom('webhook_deliveries').select(['id']).where('status', '=', 'failed').execute();
    const failedCount = rows.length;
    if (failedCount === 0) return { status: 'ok', detail: 'No failed webhook deliveries.', failedCount };
    return { status: 'warning', detail: `${failedCount} failed webhook delivery(ies).`, failedCount };
  }

  private async checkIntegrationFailures(db: Kysely<Database>): Promise<HealthCheckResult & { failedCount: number }> {
    const rows = await db.selectFrom('integration_connections').select(['id']).where('status', '=', 'error').execute();
    const failedCount = rows.length;
    if (failedCount === 0) return { status: 'ok', detail: 'No integration connections in an error state.', failedCount };
    return { status: 'warning', detail: `${failedCount} integration connection(s) in an error state.`, failedCount };
  }

  private async safeCount(pool: Pool, sql: string): Promise<number> {
    try {
      const result = await pool.query<{ n: number }>(sql);
      return result.rows[0]?.n ?? 0;
    } catch {
      return 0;
    }
  }
}
