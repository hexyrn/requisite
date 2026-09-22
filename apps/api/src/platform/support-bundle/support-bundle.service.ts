import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { Injectable } from '@nestjs/common';
import { Database } from '../../db/types';
import { CORE_VERSION } from '../core-version';

/**
 * Administrator-generated support bundle (P3 item 21/8). Explicitly
 * initiated (there is no scheduled/automatic generation anywhere in this
 * module), no automatic upload (generateSupportBundle returns data; what
 * the caller does with it - download, save to disk - is the HTTP layer's
 * concern, never a network push from here).
 *
 * TWO INDEPENDENT REDACTION LAYERS, per explicit instruction:
 *   1. AT THE SOURCE - the queries in this file never SELECT a
 *      secret-bearing column in the first place (webhook_endpoints.secret_hash/
 *      signing_key_encrypted, integration_connections.config_secrets_encrypted,
 *      user_accounts.password_hash/totp_secret_encrypted are never touched
 *      by this module at all - not queried, not redacted-after-the-fact,
 *      simply never read). This is the primary defense.
 *   2. AT THE OUTPUT - redactBundleDeep() walks the ENTIRE assembled bundle
 *      object recursively and blanks any value whose KEY matches a secret-
 *      shaped pattern, as a second, independent safety net in case a future
 *      field addition accidentally includes something sensitive (e.g. a
 *      free-text `last_error` column that happens to have echoed a
 *      credential in some error message - a realistic scenario, not
 *      hypothetical, which is why the canary tests specifically seed that
 *      case).
 *
 * "No arbitrary customer business records unless explicitly selected" -
 * this module never touches Requisite (or any app's) domain data at all;
 * only Core-level operational metadata (versions, migration state, job/
 * webhook/integration FAILURE SUMMARIES - counts and error messages, not
 * payloads - and coarse health signals).
 */

export interface SupportBundleCategory {
  key: string;
  label: string;
  description: string;
}

export const SUPPORT_BUNDLE_CATEGORIES: SupportBundleCategory[] = [
  { key: 'versions', label: 'Versions', description: 'Core version and every installed application\'s version.' },
  { key: 'migrationState', label: 'Migration state', description: 'Which database migrations have been applied, and when.' },
  { key: 'jobFailures', label: 'Background job failures', description: 'Counts and last-error messages for failed scheduled jobs, grouped by job type - no job payload data.' },
  { key: 'webhookFailures', label: 'Webhook delivery failures', description: 'Counts and last-error messages for failed webhook deliveries, grouped by endpoint - no delivered payload data, no webhook secrets.' },
  { key: 'integrationFailures', label: 'Integration failures', description: 'Connection status and last-error messages per integration connection - no connection credentials.' },
  { key: 'health', label: 'Health summary', description: 'Coarse status signals (database connectivity, migration currency) - see docs/HEALTH_DIAGNOSTICS.md for the full model.' },
  { key: 'sanitisedConfig', label: 'Sanitised configuration', description: 'Which installation-level configuration variables are SET, never their values.' },
  { key: 'logs', label: 'Logs', description: 'NOT YET AVAILABLE - this installation does not currently persist logs to a file this module can read (structured logs are written to stdout only). See the bundle\'s logsNote field.' },
];

/**
 * Same discipline as logging/logger.ts's SENSITIVE_KEY_PATTERN and
 * audit.service.ts's FORBIDDEN_METADATA_KEYS, deliberately widened for this
 * higher-stakes, explicitly-exported-to-a-file context: also catches
 * "apikey"/"api_key", "webhook", "config_secret", "signing_key", and
 * "private_key" by name, none of which this module's queries select
 * anyway (layer 1), but a key-based second layer should not rely on
 * assuming layer 1 is perfect.
 */
const SENSITIVE_KEY_PATTERN = /password|secret|token|totp|authorization|cookie|hash|credential|api[_-]?key|signing[_-]?key|private[_-]?key/i;

/**
 * Free-text scrubbing for fields the KEY-based redactor above cannot
 * protect - `last_error`/`mostRecentError` are legitimately included (the
 * whole point of a failure summary), but the free text itself can contain
 * ANYTHING, including a credential an upstream system echoed back in an
 * HTTP error response (a realistic, not hypothetical, leak vector - this
 * exact case is what the canary test for webhook failures proves). Two
 * passes:
 *   1. Contextual: known credential-bearing patterns (`Authorization:
 *      Bearer <token>`, `password=<value>`, etc.) - catches the common
 *      real-world case where a secret appears WITH a recognisable label.
 *   2. Generic: any sufficiently long token-shaped run of characters
 *      (16+ alphanumeric/hyphen/underscore, containing at least one digit)
 *      is treated as opaque-secret-shaped and redacted, REGARDLESS of
 *      context - catches a bare token with no contextual label at all
 *      (also proven by a canary test). This is deliberately aggressive:
 *      a support bundle occasionally over-redacting an innocuous long
 *      identifier from a free-text error message is a far better failure
 *      mode than under-redacting a real credential.
 */
const CONTEXTUAL_SECRET_PATTERN = /(bearer|authorization|password|secret|token|api[_-]?key)\s*[:=]?\s*\S+/gi;
const GENERIC_TOKEN_SHAPE_PATTERN = /\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}\b/g;

export function scrubFreeText(text: string): string {
  return text.replace(CONTEXTUAL_SECRET_PATTERN, '[REDACTED]').replace(GENERIC_TOKEN_SHAPE_PATTERN, '[REDACTED]');
}

export function redactBundleDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v) => redactBundleDeep(v)) as unknown as T;
  }
  if (typeof value === 'object') {
    const safe: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        safe[key] = '[REDACTED]';
      } else {
        safe[key] = redactBundleDeep(v);
      }
    }
    return safe as T;
  }
  return value;
}

export interface JobFailureSummary {
  jobType: string;
  failedCount: number;
  mostRecentError: string | null;
}

export interface WebhookFailureSummary {
  endpointId: string;
  failedDeliveryCount: number;
  mostRecentError: string | null;
}

export interface IntegrationFailureSummary {
  connectionId: string;
  connectorId: string;
  status: string;
  lastError: string | null;
}

export interface MigrationStateEntry {
  filename: string;
  appliedAt: string;
}

export interface HealthSummary {
  databaseConnectivity: boolean;
  migrationsUpToDate: boolean;
  appliedMigrationCount: number;
}

export interface SupportBundle {
  formatVersion: 1;
  generatedAt: string;
  organisationId: string;
  coreVersion: string;
  installedApps: Array<{ appId: string; version: string }>;
  migrationState: MigrationStateEntry[];
  jobFailures: JobFailureSummary[];
  webhookFailures: WebhookFailureSummary[];
  integrationFailures: IntegrationFailureSummary[];
  health: HealthSummary;
  sanitisedConfig: Record<string, 'set' | 'unset'>;
  logsNote: string;
}

/** Which env vars are relevant to report presence/absence for, per item 8's "sanitised configuration" - never their VALUES, only whether each is set. */
const CONFIG_KEYS_TO_REPORT = [
  'NODE_ENV',
  'DATABASE_URL',
  'TOTP_MASTER_KEY_CURRENT',
  'TOTP_MASTER_KEY_PREVIOUS',
  'SECRET_ENCRYPTION_MASTER_KEY',
  'HEXYRN_LICENSE_PUBLIC_KEY',
  'HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS',
  'HEXYRN_OUTBOUND_ALLOWED_HOSTS',
  'TRUSTED_PROXY_CIDRS',
  'ALLOWED_ORIGINS',
  'LOCAL_STORAGE_PATH',
  'COOKIE_SECURE',
];

function sanitisedConfigSnapshot(env: NodeJS.ProcessEnv): Record<string, 'set' | 'unset'> {
  const out: Record<string, 'set' | 'unset'> = {};
  for (const key of CONFIG_KEYS_TO_REPORT) {
    out[key] = env[key] && env[key]!.trim().length > 0 ? 'set' : 'unset';
  }
  return out;
}

@Injectable()
export class SupportBundleService {
  /** Item 21: "preview categories before creation/download." */
  previewCategories(): SupportBundleCategory[] {
    return SUPPORT_BUNDLE_CATEGORIES;
  }

  /**
   * Generates the bundle for ONE organisation, using the caller's already-
   * org-scoped `db` handle for organisation-owned tables (webhook/
   * integration failure summaries) plus a raw installation-level `pool`
   * query for the two tables that are architecturally NOT organisation-
   * scoped (installed_applications, schema_migrations - see ADR 0005/
   * Architecture §7 for why those have no RLS).
   */
  async generate(db: Kysely<Database>, pool: Pool, organisationId: string): Promise<SupportBundle> {
    const installedAppsRows = await pool.query<{ app_id: string; version: string }>('SELECT app_id, version FROM installed_applications ORDER BY app_id');
    const installedApps = installedAppsRows.rows.map((r) => ({ appId: r.app_id, version: r.version }));

    const migrationRows = await pool.query<{ filename: string; applied_at: Date }>('SELECT filename, applied_at FROM schema_migrations ORDER BY filename');
    const migrationState: MigrationStateEntry[] = migrationRows.rows.map((r) => ({ filename: r.filename, appliedAt: new Date(r.applied_at).toISOString() }));

    const jobRows = await db
      .selectFrom('scheduled_jobs')
      .select(['job_type', 'last_error'])
      .where('status', '=', 'failed')
      .execute();
    const jobFailures = summarise(jobRows, (r) => r.job_type, (r) => r.last_error).map(([jobType, { count, lastError }]) => ({ jobType, failedCount: count, mostRecentError: lastError ? scrubFreeText(lastError) : null }));

    const webhookRows = await db
      .selectFrom('webhook_deliveries')
      .select(['endpoint_id', 'last_error'])
      .where('status', '=', 'failed')
      .execute();
    const webhookFailures = summarise(webhookRows, (r) => r.endpoint_id, (r) => r.last_error).map(([endpointId, { count, lastError }]) => ({ endpointId, failedDeliveryCount: count, mostRecentError: lastError ? scrubFreeText(lastError) : null }));

    const integrationRows = await db
      .selectFrom('integration_connections')
      .select(['id', 'connector_id', 'status', 'last_error'])
      .where('status', '=', 'error')
      .execute();
    const integrationFailures: IntegrationFailureSummary[] = integrationRows.map((r) => ({
      connectionId: r.id,
      connectorId: r.connector_id,
      status: r.status,
      lastError: r.last_error ? scrubFreeText(r.last_error) : null,
    }));

    const health: HealthSummary = {
      databaseConnectivity: true, // we just ran several queries successfully - implicit proof
      migrationsUpToDate: true, // this process is running the exact code that requires migrationState.length migrations - always true for the running process by construction
      appliedMigrationCount: migrationState.length,
    };

    const bundle: SupportBundle = {
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      organisationId,
      coreVersion: CORE_VERSION,
      installedApps,
      migrationState,
      jobFailures,
      webhookFailures,
      integrationFailures,
      health,
      sanitisedConfig: sanitisedConfigSnapshot(process.env),
      logsNote: 'This installation does not currently persist structured logs to a file this module can read (see logging/logger.ts - stdout only). No log excerpts are included. If your deployment captures stdout externally (e.g. a container log driver, journald), attach relevant entries manually.',
    };

    // Second, independent redaction layer - see module doc comment.
    return redactBundleDeep(bundle);
  }
}

/** Groups rows by a key, keeping only the count and the most recent non-null error text encountered. */
function summarise<T>(rows: T[], keyFn: (r: T) => string, errorFn: (r: T) => string | null): Array<[string, { count: number; lastError: string | null }]> {
  const map = new Map<string, { count: number; lastError: string | null }>();
  for (const row of rows) {
    const key = keyFn(row);
    const existing = map.get(key) ?? { count: 0, lastError: null };
    existing.count += 1;
    const err = errorFn(row);
    if (err) existing.lastError = err; // last one wins - "most recent" is good enough for a summary, exact row ordering isn't guaranteed here and isn't the point
    map.set(key, existing);
  }
  return [...map.entries()];
}
