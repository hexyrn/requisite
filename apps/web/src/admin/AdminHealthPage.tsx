import React, { useEffect, useState } from 'react';
import { Card, Button, StatusBadge } from '@hexyrn/design-system';
import { healthApi, SystemHealth } from '../api/admin';
import { toneForStatus } from './statusTone';

/** P3 items 19/20: operator-facing system health and diagnostics. */
export function AdminHealthPage() {
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function reload() {
    setError(null);
    Promise.all([healthApi.getHealth(), healthApi.getDiagnostics()])
      .then(([h, d]) => {
        setHealth(h);
        setDiagnostics(d);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load system health.'),
      );
  }

  useEffect(reload, []);

  async function refresh() {
    setLoading(true);
    try {
      reload();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {error && (
        <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>
          {error}
        </div>
      )}
      <div style={{ marginBottom: 12 }}>
        <Button onClick={refresh} disabled={loading}>
          Refresh
        </Button>
      </div>

      {health && (
        <Card>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>
            Overall status:{' '}
            <StatusBadge label={health.overallStatus} tone={toneForStatus(health.overallStatus)} />
          </h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              Database:{' '}
              <StatusBadge
                label={health.database.status}
                tone={toneForStatus(health.database.status)}
              />{' '}
              — {health.database.detail}
            </li>
            <li>
              Migrations:{' '}
              <StatusBadge
                label={health.migrations.status}
                tone={toneForStatus(health.migrations.status)}
              />{' '}
              — {health.migrations.detail}
            </li>
          </ul>
        </Card>
      )}

      {diagnostics && (
        <Card>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Diagnostics</h2>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              background: '#f5f6f8',
              padding: 12,
              borderRadius: 6,
            }}
          >
            {JSON.stringify(diagnostics, null, 2)}
          </pre>
        </Card>
      )}

      {!health && !error && <p>Loading…</p>}
    </div>
  );
}
