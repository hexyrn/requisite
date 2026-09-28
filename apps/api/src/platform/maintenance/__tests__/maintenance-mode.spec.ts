import { Pool } from 'pg';
import {
  checkMaintenanceMode,
  setMaintenanceMode,
  isMaintenanceModeActive,
  resetMaintenanceModeForTests,
  setMaintenanceModeFlagForTests,
  MAINTENANCE_RESPONSE_BODY,
} from '../maintenance-mode';

describe('Maintenance mode enforcement (P3 item 4)', () => {
  afterEach(() => resetMaintenanceModeForTests());

  it('is inactive by default - nothing blocked', () => {
    expect(isMaintenanceModeActive()).toBe(false);
    expect(checkMaintenanceMode('POST', '/api/v1/requisite/requisitions').blocked).toBe(false);
  });

  describe('while active', () => {
    it('blocks an ordinary state-changing business request', () => {
      setMaintenanceModeFlagForTests(true);
      const result = checkMaintenanceMode('POST', '/api/v1/requisite/requisitions');
      expect(result.blocked).toBe(true);
    });

    it('blocks PUT/PATCH/DELETE too, not just POST', () => {
      setMaintenanceModeFlagForTests(true);
      expect(checkMaintenanceMode('PUT', '/api/v1/requisite/suppliers/123').blocked).toBe(true);
      expect(checkMaintenanceMode('PATCH', '/api/v1/requisite/suppliers/123').blocked).toBe(true);
      expect(checkMaintenanceMode('DELETE', '/api/v1/requisite/suppliers/123').blocked).toBe(true);
    });

    it('does NOT block ordinary GET (read-only) requests', () => {
      setMaintenanceModeFlagForTests(true);
      expect(checkMaintenanceMode('GET', '/api/v1/requisite/requisitions').blocked).toBe(false);
    });

    it('does NOT block health/diagnostics endpoints - needed to observe maintenance in progress', () => {
      setMaintenanceModeFlagForTests(true);
      expect(checkMaintenanceMode('GET', '/api/v1/health').blocked).toBe(false);
      expect(checkMaintenanceMode('GET', '/api/v1/system/health').blocked).toBe(false);
      expect(checkMaintenanceMode('GET', '/api/v1/system/diagnostics').blocked).toBe(false);
    });

    it('does NOT block the backup/update/support-bundle admin endpoints themselves - an admin must be able to recover', () => {
      setMaintenanceModeFlagForTests(true);
      expect(checkMaintenanceMode('POST', '/api/v1/backup').blocked).toBe(false);
      expect(checkMaintenanceMode('POST', '/api/v1/backup/some-id/restore').blocked).toBe(false);
      expect(checkMaintenanceMode('POST', '/api/v1/update/apply').blocked).toBe(false);
      expect(checkMaintenanceMode('POST', '/api/v1/support-bundle').blocked).toBe(false);
    });

    it('does NOT block login/logout - an admin must be able to authenticate to reach the above', () => {
      setMaintenanceModeFlagForTests(true);
      expect(checkMaintenanceMode('POST', '/api/v1/auth/login').blocked).toBe(false);
      expect(checkMaintenanceMode('POST', '/api/v1/auth/logout').blocked).toBe(false);
    });

    it('DOES block an unrelated auth mutation (e.g. MFA enrolment) - the allowlist is narrow, not "all of /auth"', () => {
      setMaintenanceModeFlagForTests(true);
      expect(checkMaintenanceMode('POST', '/api/v1/auth/mfa/enroll/confirm').blocked).toBe(true);
    });
  });

  describe('setMaintenanceMode (real Postgres persistence)', () => {
    const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
    const maybeIt = TEST_DATABASE_URL ? it : it.skip;

    maybeIt(
      'sets the in-memory flag AND persists it to installations.config, and clearing it correctly un-blocks traffic (never permanently stuck)',
      async () => {
        const pool = new Pool({ connectionString: TEST_DATABASE_URL });
        try {
          await pool.query(
            `INSERT INTO installations (core_version) SELECT '0.1.0-maint-test' WHERE NOT EXISTS (SELECT 1 FROM installations)`,
          );

          await setMaintenanceMode(pool, true);
          expect(isMaintenanceModeActive()).toBe(true);
          expect(checkMaintenanceMode('POST', '/api/v1/requisite/requisitions').blocked).toBe(true);
          const rowDuringMaintenance = await pool.query<{ config: any }>(
            'SELECT config FROM installations LIMIT 1',
          );
          expect(rowDuringMaintenance.rows[0].config.maintenanceMode).toBe(true);

          // Simulates the "recoverable failure" case from P3 item 4's
          // requirement: even after maintenance mode was entered, clearing
          // it (as applyUpdate()'s own try/finally guarantees on an
          // unexpected error, or as an operator recovering manually) must
          // genuinely un-block traffic - proving the enforcement mechanism
          // itself cannot leave the app permanently stuck once the flag is
          // cleared, which is the property that actually matters here (the
          // ORCHESTRATION-level "never silently stuck" guarantee is already
          // proven by update.service.spec.ts's maintenance-mode tests).
          await setMaintenanceMode(pool, false);
          expect(isMaintenanceModeActive()).toBe(false);
          expect(checkMaintenanceMode('POST', '/api/v1/requisite/requisitions').blocked).toBe(
            false,
          );
          const rowAfter = await pool.query<{ config: any }>(
            'SELECT config FROM installations LIMIT 1',
          );
          expect(rowAfter.rows[0].config.maintenanceMode).toBe(false);
        } finally {
          await pool.end();
        }
      },
    );
  });

  it('MAINTENANCE_RESPONSE_BODY is a clear, user-facing 503 - not a raw error', () => {
    expect(MAINTENANCE_RESPONSE_BODY.statusCode).toBe(503);
    expect(MAINTENANCE_RESPONSE_BODY.message).toMatch(/maintenance/i);
    expect(MAINTENANCE_RESPONSE_BODY.maintenanceMode).toBe(true);
  });
});
