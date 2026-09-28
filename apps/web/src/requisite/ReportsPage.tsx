import React, { useEffect, useState } from 'react';
import { PageHeader, Card, Button, EmptyState } from '@hexyrn/design-system';
import { reportsApi, ReportTemplate } from '../api/reports';

const APP_ID = 'com.hexyrn.requisite';

/**
 * Reports (item 15) - Requisite's registered report templates
 * (requisite-p2-extensions.ts) surfaced through Core's generic report
 * interface (ReportsController), never a separate Requisite reporting
 * engine. Running a report is permission-checked identically to any
 * other report query - a user without the underlying dataset permission
 * gets a clear error, not partial/leaked data.
 */
export function ReportsPage() {
  const [templates, setTemplates] = useState<ReportTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<{ name: string; rows: Record<string, unknown>[] } | null>(
    null,
  );
  const [resultError, setResultError] = useState<string | null>(null);

  useEffect(() => {
    reportsApi
      .listTemplates(APP_ID)
      .then(setTemplates)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load reports.'));
  }, []);

  async function runReport(templateKey: string) {
    setRunning(templateKey);
    setResultError(null);
    setResult(null);
    try {
      const data = await reportsApi.execute(templateKey);
      setResult(data);
    } catch (err) {
      setResultError(err instanceof Error ? err.message : 'Could not run this report.');
    } finally {
      setRunning(null);
    }
  }

  const columns = result && result.rows[0] ? Object.keys(result.rows[0]) : [];

  return (
    <div>
      <PageHeader title="Reports" />
      {error && (
        <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>
          {error}
        </div>
      )}

      {templates === null ? (
        <p>Loading…</p>
      ) : templates.length === 0 ? (
        <EmptyState message="No reports are available yet." />
      ) : (
        <Card>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Available Reports</h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {templates.map((t) => (
              <li
                key={t.template_key}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: '1px solid #f3f4f6',
                }}
              >
                <span>{t.name}</span>
                <Button
                  onClick={() => runReport(t.template_key)}
                  disabled={running === t.template_key}
                >
                  {running === t.template_key ? 'Running…' : 'Run'}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {resultError && (
        <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>
          {resultError}
        </div>
      )}

      {result && (
        <Card>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>{result.name}</h2>
          {result.rows.length === 0 ? (
            <p style={{ color: '#6b7280', fontSize: 14 }}>This report returned no data.</p>
          ) : (
            <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c}
                      style={{
                        textAlign: 'left',
                        padding: '4px 8px',
                        borderBottom: '2px solid #e5e7eb',
                      }}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                    {columns.map((c) => (
                      <td key={c} style={{ padding: '4px 8px' }}>
                        {String(row[c] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
