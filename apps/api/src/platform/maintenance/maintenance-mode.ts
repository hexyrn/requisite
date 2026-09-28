import { Pool } from 'pg';

/**
 * Real maintenance-mode enforcement (P3 item 4 of the coordinator's
 * follow-up list). Before this existed, update.controller.ts's
 * enter/exitMaintenanceMode only wrote a flag to installations.config -
 * real, queryable, but nothing rejected ordinary traffic while it was set
 * (stated plainly as a gap in the previous P3 round). This closes it.
 *
 * DESIGN: an in-memory flag, not a per-request DB read - this codebase is
 * documented (P3 item 12) as a deliberately single-process v1 deployment,
 * so an in-memory flag is correct and fast, not a shortcut; it is ALSO
 * persisted to installations.config (setMaintenanceMode below still
 * writes there) so the state is visible to GET /api/v1/system/health and
 * survives being queried across the same process's lifetime - a process
 * RESTART during maintenance mode would lose the in-memory flag, which is
 * an accepted limitation for a single-process v1 (a restart mid-update is
 * already an exceptional, manually-investigated situation per
 * docs/OPERATOR_GUIDE.md §7's "migration/health-check failure leaves you
 * in maintenance mode - restore a backup" guidance).
 *
 * WHAT IS ALLOWED THROUGH while maintenance mode is active:
 *   - GET requests to health/diagnostics (`/api/v1/system/health`,
 *     `/api/v1/system/diagnostics`, the public `/api/v1/health` liveness
 *     probe) - needed to observe the maintenance in progress.
 *   - The backup/update/support-bundle admin endpoints themselves
 *     (`/api/v1/backup*`, `/api/v1/update*`, `/api/v1/support-bundle*`) -
 *     an admin must be able to check on or recover from the very
 *     operation that set maintenance mode.
 *   - `/api/v1/auth/login` and `/api/v1/auth/logout` - an admin must be
 *     able to authenticate to reach the endpoints above in the first
 *     place, and log out.
 * WHAT IS BLOCKED: every other state-changing (POST/PUT/PATCH/DELETE)
 * request - the exact "new state-changing business operations must not
 * proceed" requirement. GET requests to ordinary business endpoints are
 * NOT blocked (read-only traffic is safe to continue serving, and
 * blocking it would make routine health/status checking by any other
 * caller unnecessarily hostile) - only mutations are rejected.
 */
let maintenanceModeActive = false;

export function isMaintenanceModeActive(): boolean {
  return maintenanceModeActive;
}

/** Sets the in-memory flag AND persists it - called by update.controller.ts's enter/exitMaintenanceMode callbacks. */
export async function setMaintenanceMode(pool: Pool, active: boolean): Promise<void> {
  maintenanceModeActive = active;
  await pool.query(
    `UPDATE installations SET config = jsonb_set(coalesce(config, '{}'::jsonb), '{maintenanceMode}', $1::jsonb, true)`,
    [JSON.stringify(active)],
  );
}

/** Test-only escape hatches - production code should only ever go through setMaintenanceMode above (which also persists to Postgres). These exist purely so checkMaintenanceMode's routing logic can be unit-tested without a database. */
export function resetMaintenanceModeForTests(): void {
  maintenanceModeActive = false;
}
export function setMaintenanceModeFlagForTests(active: boolean): void {
  maintenanceModeActive = active;
}

const ALLOWED_PATH_PREFIXES = [
  '/api/v1/health',
  '/api/v1/system/health',
  '/api/v1/system/diagnostics',
  '/api/v1/backup',
  '/api/v1/update',
  '/api/v1/support-bundle',
  '/api/v1/auth/login',
  '/api/v1/auth/logout',
];

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface MaintenanceCheckResult {
  blocked: boolean;
}

/** Pure function - the actual Fastify hook (main.ts) wraps this; kept pure and exported so it's unit-testable without a real HTTP server. */
export function checkMaintenanceMode(method: string, path: string): MaintenanceCheckResult {
  if (!maintenanceModeActive) return { blocked: false };
  if (!MUTATING_METHODS.has(method.toUpperCase())) return { blocked: false }; // reads always allowed
  const allowed = ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
  return { blocked: !allowed };
}

export const MAINTENANCE_RESPONSE_BODY = {
  statusCode: 503,
  error: 'Service Unavailable',
  message:
    'Hexyrn is currently in maintenance mode (an update or restore is in progress). Please try again shortly.',
  maintenanceMode: true,
};
