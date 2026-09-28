import React, { useEffect, useState } from 'react';
import { Card, Button, Input, StatusBadge } from '@hexyrn/design-system';
import { licenceApi, LicenceDetail } from '../api/admin';
import { toneForBool } from './statusTone';

const REQUISITE_APP_ID = 'com.hexyrn.requisite';

/** P3 item 10/25: licence administration - detail view + import (offline, no activation server). */
export function AdminLicencePage() {
  const [detail, setDetail] = useState<LicenceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [majorVersion, setMajorVersion] = useState('1');
  const [licenceJson, setLicenceJson] = useState('');
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  function reload() {
    setError(null);
    licenceApi
      .getLicence(REQUISITE_APP_ID)
      .then(setDetail)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load licence detail.'),
      );
  }

  useEffect(reload, []);

  async function onImport() {
    let licence: Record<string, unknown>;
    try {
      licence = JSON.parse(licenceJson);
    } catch {
      setError('Licence must be valid JSON (paste the .licence file contents).');
      return;
    }
    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await licenceApi.importLicence(
        REQUISITE_APP_ID,
        Number(majorVersion),
        licence,
      );
      setDetail(result);
      setMessage('Licence imported.');
      setLicenceJson('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Licence import failed.');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      {error && (
        <div role="alert" style={{ color: 'var(--hx-danger)', marginBottom: 12 }}>
          {error}
        </div>
      )}
      {message && (
        <div role="status" style={{ color: 'var(--hx-success)', marginBottom: 12 }}>
          {message}
        </div>
      )}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Hexyrn Requisite licence</h2>
        {detail ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              Licence valid:{' '}
              <StatusBadge
                label={detail.licenceValid ? 'Yes' : 'No'}
                tone={toneForBool(detail.licenceValid)}
              />
            </li>
            <li>
              Support expired:{' '}
              <StatusBadge
                label={detail.supportExpired ? 'Yes' : 'No'}
                tone={toneForBool(!detail.supportExpired)}
              />
            </li>
            <li>
              Active:{' '}
              <StatusBadge label={detail.active ? 'Yes' : 'No'} tone={toneForBool(detail.active)} />
            </li>
          </ul>
        ) : (
          <p>Loading…</p>
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Import licence file</h2>
        <p style={{ color: 'var(--hx-text-muted)', marginBottom: 8 }}>
          Verified offline via cryptographic signature - no internet activation required.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 640 }}>
          <Input
            label="Major version"
            value={majorVersion}
            onChange={(e) => setMajorVersion(e.target.value)}
          />
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            Licence file contents (JSON)
            <textarea
              value={licenceJson}
              onChange={(e) => setLicenceJson(e.target.value)}
              rows={6}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, marginTop: 4 }}
            />
          </label>
          <Button onClick={onImport} disabled={importing || !licenceJson.trim()}>
            {importing ? 'Importing…' : 'Import Licence'}
          </Button>
        </div>
      </Card>
    </div>
  );
}
