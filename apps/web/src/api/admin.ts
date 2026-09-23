import { request } from './client';

/**
 * Admin/operator API bindings for the five P3 admin screens (backup,
 * update, support bundle, licence, SMTP) plus system health/diagnostics.
 * Every call here targets an ORGANISATION_MANAGE-gated endpoint - the
 * backend rejects anyone without that permission; this module does not
 * duplicate that check, it only calls the real endpoints (see each
 * controller under apps/api/src/platform/*).
 */

// --- Backup (apps/api/src/platform/backup/backup.controller.ts) ---
export interface BackupSummary {
  backupId: string;
  valid: boolean;
  issues: string[];
  createdAt: string | null;
  coreVersion: string | null;
}
export interface BackupDetail {
  valid: boolean;
  issues: string[];
  manifest: Record<string, unknown> | null;
}

export const backupApi = {
  list: () => request<{ backups: BackupSummary[] }>('/backup'),
  get: (id: string) => request<BackupDetail>(`/backup/${encodeURIComponent(id)}`),
  createNow: () => request<{ backupId: string; manifest: Record<string, unknown> }>('/backup', { method: 'POST' }),
  restore: (id: string) =>
    request<{ restored: boolean; manifest: Record<string, unknown>; filesRestored: number }>(
      `/backup/${encodeURIComponent(id)}/restore`,
      { method: 'POST', body: JSON.stringify({ confirmed: true }) },
    ),
};

// --- Update (apps/api/src/platform/update/update.controller.ts) ---
export interface UpdateCheckResult {
  runningCoreVersion: string;
  packageVersion: string;
  packageAuthentic: boolean;
  packageAuthenticityDetail: string;
  compatible: boolean;
  compatibilityDetail: string;
  migrationNotes: string | null;
  diskSpaceOk: boolean;
  readyToApply: boolean;
}

export const updateApi = {
  check: (packagePath: string, manifest: Record<string, unknown>) =>
    request<UpdateCheckResult>('/update/check', { method: 'POST', body: JSON.stringify({ packagePath, manifest }) }),
  apply: (packagePath: string, manifest: Record<string, unknown>, requireBackup: boolean) =>
    request<{ succeeded: boolean; steps: Array<{ step: string; ok: boolean; detail?: string }> }>('/update/apply', {
      method: 'POST',
      body: JSON.stringify({ packagePath, manifest, confirmed: true, requireBackup }),
    }),
};

// --- Support bundle (apps/api/src/platform/support-bundle/support-bundle.controller.ts) ---
export const supportBundleApi = {
  previewCategories: () => request<{ categories: string[] }>('/support-bundle/preview'),
  generate: () => request<Record<string, unknown>>('/support-bundle', { method: 'POST' }),
};

// --- Licence (apps/api/src/platform/app-registry/app-state.controller.ts) ---
export interface LicenceDetail {
  licenceValid: boolean;
  supportExpired: boolean;
  active: boolean;
  [key: string]: unknown;
}

export const licenceApi = {
  getState: (appId: string) => request<Record<string, unknown>>(`/apps/${encodeURIComponent(appId)}/state`),
  getLicence: (appId: string) => request<LicenceDetail>(`/apps/${encodeURIComponent(appId)}/licence`),
  importLicence: (appId: string, majorVersion: number, licence: Record<string, unknown>) =>
    request<LicenceDetail>(`/apps/${encodeURIComponent(appId)}/licence`, {
      method: 'POST',
      body: JSON.stringify({ majorVersion, licence }),
    }),
};

// --- SMTP (apps/api/src/platform/smtp/smtp.controller.ts) ---
export interface SmtpConfigDisplay {
  host: string | null;
  port: number | null;
  secure: boolean | null;
  username: string | null;
  fromAddress: string | null;
  configured: boolean;
}

export const smtpApi = {
  get: () => request<SmtpConfigDisplay>('/smtp'),
  set: (config: { host: string; port: number; secure: boolean; username?: string; password?: string; fromAddress: string }) =>
    request<SmtpConfigDisplay>('/smtp', { method: 'POST', body: JSON.stringify(config) }),
  clear: () => request<{ cleared: boolean }>('/smtp', { method: 'DELETE' }),
  sendTest: (to: string) => request<{ success: boolean; error?: string }>('/smtp/test', { method: 'POST', body: JSON.stringify({ to }) }),
};

// --- Health/diagnostics (apps/api/src/platform/health/health-diagnostics.controller.ts) ---
export interface HealthCheck {
  status: 'ok' | 'warn' | 'error';
  detail: string;
}
export interface SystemHealth {
  overallStatus: 'ok' | 'warn' | 'error';
  database: HealthCheck;
  migrations: HealthCheck;
  [key: string]: unknown;
}

export const healthApi = {
  getHealth: () => request<SystemHealth>('/system/health'),
  getDiagnostics: () => request<Record<string, unknown>>('/system/diagnostics'),
};
