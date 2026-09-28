import React, { useEffect, useState } from 'react';
import { Card, Button, Table, EmptyState, StatusBadge } from '@hexyrn/design-system';
import { backupApi, BackupSummary } from '../api/admin';
import { toneForBool } from './statusTone';

/** P3 item 9-13: "Backup Now", destination/schedule/retention status, last successful backup, restore. */
export function AdminBackupPage() {
  const [backups, setBackups] = useState<BackupSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function reload() {
    setError(null);
    backupApi
      .list()
      .then((res) => setBackups(res.backups))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load backups.'));
  }

  useEffect(reload, []);

  async function onCreate() {
    setCreating(true);
    setError(null);
    setMessage(null);
    try {
      const result = await backupApi.createNow();
      setMessage(`Backup created: ${result.backupId}`);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup failed.');
    } finally {
      setCreating(false);
    }
  }

  async function onRestore(id: string) {
    setRestoringId(id);
    setError(null);
    setMessage(null);
    try {
      const result = await backupApi.restore(id);
      setMessage(`Restore complete: ${result.filesRestored} file(s) restored from ${id}.`);
      setConfirmId(null);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restore failed.');
    } finally {
      setRestoringId(null);
    }
  }

  const lastGood = backups?.find((b) => b.valid) ?? null;

  return (
    <div>
      {error && (
        <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>
          {error}
        </div>
      )}
      {message && (
        <div role="status" style={{ color: '#166534', marginBottom: 12 }}>
          {message}
        </div>
      )}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Backup now</h2>
        <p style={{ color: '#616e7c', marginBottom: 8 }}>
          Captures the full installation database and uploaded files as one coordinated unit.
          {lastGood
            ? ` Last successful backup: ${lastGood.backupId}.`
            : ' No successful backup yet.'}
        </p>
        <Button onClick={onCreate} disabled={creating}>
          {creating ? 'Creating backup…' : 'Backup Now'}
        </Button>
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Backups</h2>
        {backups === null ? (
          <p>Loading…</p>
        ) : backups.length === 0 ? (
          <EmptyState message="No backups yet." />
        ) : (
          <Table<BackupSummary>
            rowKey={(b) => b.backupId}
            rows={backups}
            columns={[
              { key: 'backupId', header: 'Backup' },
              { key: 'createdAt', header: 'Created', render: (b) => b.createdAt ?? '—' },
              { key: 'coreVersion', header: 'Core version', render: (b) => b.coreVersion ?? '—' },
              {
                key: 'valid',
                header: 'Integrity',
                render: (b) => (
                  <StatusBadge label={b.valid ? 'Valid' : 'Invalid'} tone={toneForBool(b.valid)} />
                ),
              },
              {
                key: 'actions',
                header: '',
                render: (b) =>
                  confirmId === b.backupId ? (
                    <span style={{ display: 'flex', gap: 8 }}>
                      <span style={{ color: '#991b1b', fontSize: 12 }}>
                        Overwrites current data.
                      </span>
                      <Button
                        variant="secondary"
                        onClick={() => onRestore(b.backupId)}
                        disabled={restoringId === b.backupId}
                      >
                        {restoringId === b.backupId ? 'Restoring…' : 'Confirm restore'}
                      </Button>
                      <Button variant="secondary" onClick={() => setConfirmId(null)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() => setConfirmId(b.backupId)}
                      disabled={!b.valid}
                    >
                      Restore…
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}
