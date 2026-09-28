import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, StatusBadge } from '@hexyrn/design-system';
import { licenceApi, LicenceDetail } from '../api/admin';
import { useShell } from '../shell/ShellContext';
import { toneForBool } from './statusTone';

const REQUISITE_APP_ID = 'com.hexyrn.requisite';

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsText(file);
  });
}

/**
 * Licence activation (offline - no activation server). The normal customer path is one step:
 * choose the .licence file Hexyrn sent, and it is verified and imported immediately. Pasting the
 * file contents is still available. The first import also activates Requisite for the organisation.
 */
export function AdminLicencePage() {
  const shell = useShell();
  const [params] = useSearchParams();
  const firstRun = params.get('firstRun') === '1';
  const [detail, setDetail] = useState<LicenceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [licenceJson, setLicenceJson] = useState('');
  const [importing, setImporting] = useState(false);
  const [activated, setActivated] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const requisite = shell.apps.find((a) => a.appId === REQUISITE_APP_ID);

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

  async function importText(text: string) {
    let licence: Record<string, unknown>;
    try {
      licence = JSON.parse(text);
    } catch {
      setError('That is not a valid licence file. Choose the .licence file Hexyrn sent you.');
      return;
    }
    const majorVersion = Number(licence.majorVersion);
    if (!Number.isInteger(majorVersion) || majorVersion < 1) {
      setError('That file does not look like a Requisite licence (no version found).');
      return;
    }
    setImporting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await licenceApi.importLicence(REQUISITE_APP_ID, majorVersion, licence);
      setDetail(result);
      setLicenceJson('');
      setActivated(Boolean(result.active));
      setMessage(
        result.activated ? 'Licence accepted and Requisite is now active.' : 'Licence accepted.',
      );
      await shell.refresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Licence import failed.');
    } finally {
      setImporting(false);
    }
  }

  async function onChooseFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow choosing the same file again after a failure
    if (!file) return;
    try {
      await importText(await readFileAsText(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the file.');
    }
  }

  return (
    <div>
      {firstRun && !activated && (
        <Alert tone="info">
          <strong>Your organisation is ready.</strong> One last step: activate Requisite with the
          licence file Hexyrn sent you.
        </Alert>
      )}
      {error && <Alert>{error}</Alert>}
      {message && <Alert tone="success">{message}</Alert>}
      {activated && requisite && (
        <p>
          <Link to={requisite.launchPath}>
            <Button>Open Requisite</Button>
          </Link>
        </p>
      )}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Activate Requisite</h2>
        <p style={{ color: 'var(--hx-text-muted)', marginBottom: 12 }}>
          Choose your licence file. It is checked on this computer (no internet connection or
          activation server is needed).
        </p>
        <label
          className="hx-btn hx-btn--primary"
          style={{ cursor: importing ? 'wait' : 'pointer' }}
        >
          {importing ? 'Checking licence…' : 'Choose licence file…'}
          <input
            type="file"
            accept=".licence,.json,.txt,application/json,text/plain"
            aria-label="Licence file"
            onChange={onChooseFile}
            disabled={importing}
            style={{ display: 'none' }}
          />
        </label>
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 14 }}>Paste the licence instead</summary>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              maxWidth: 640,
              marginTop: 8,
            }}
          >
            <label style={{ fontSize: 13, fontWeight: 600 }}>
              Pasted licence text
              <textarea
                value={licenceJson}
                onChange={(e) => setLicenceJson(e.target.value)}
                rows={6}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, marginTop: 4 }}
              />
            </label>
            <Button
              onClick={() => importText(licenceJson)}
              disabled={importing || !licenceJson.trim()}
            >
              Import Licence
            </Button>
          </div>
        </details>
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Licence status</h2>
        {detail ? (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {typeof detail.organisationId === 'string' && (
              <li>
                Organisation ID (quote this when requesting a licence):{' '}
                <code data-testid="organisation-id">{detail.organisationId}</code>
              </li>
            )}
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
    </div>
  );
}
