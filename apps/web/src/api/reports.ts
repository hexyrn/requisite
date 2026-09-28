import { request } from './client';

export interface ReportTemplate {
  template_key: string;
  app_id: string;
  name: string;
  primary_dataset: string;
}

/**
 * Core's generic report interface client (item 15) - deliberately not
 * Requisite-specific, mirroring the backend's one ReportsController that
 * serves any app's registered templates.
 */
export const reportsApi = {
  listTemplates: (appId: string) =>
    request<ReportTemplate[]>(`/reports/templates?appId=${encodeURIComponent(appId)}`),
  execute: (templateKey: string) =>
    request<{ name: string; rows: Record<string, unknown>[] }>('/reports/execute', {
      method: 'POST',
      body: JSON.stringify({ templateKey }),
    }),
};
