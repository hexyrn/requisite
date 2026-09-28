import React, { useState } from 'react';
import { Card, Button, Input, StatusBadge } from '@hexyrn/design-system';
import { updateApi, UpdateCheckResult } from '../api/admin';
import { toneForBool } from './statusTone';

/** P3 items 14/15: offline update check + apply, with disk/compatibility/authenticity checks surfaced before commit. */
export function AdminUpdatePage() {
  const [packagePath, setPackagePath] = useState('');
  const [manifestJson, setManifestJson] = useState('');
  const [checkResult, setCheckResult] = useState<UpdateCheckResult | null>(null);
  const [applyLog, setApplyLog] = useState<Array<{
    step: string;
    ok: boolean;
    detail?: string;
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function parseManifest(): Record<string, unknown> | null {
    try {
      return JSON.parse(manifestJson);
    } catch {
      setError(
        'Manifest must be valid JSON (paste the .manifest.json contents from the release package).',
      );
      return null;
    }
  }

  async function onCheck() {
    const manifest = parseManifest();
    if (!manifest || !packagePath.trim()) return;
    setBusy(true);
    setError(null);
    setCheckResult(null);
    try {
      setCheckResult(await updateApi.check(packagePath.trim(), manifest));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update check failed.');
    } finally {
      setBusy(false);
    }
  }

  async function onApply() {
    const manifest = parseManifest();
    if (!manifest || !packagePath.trim()) return;
    setBusy(true);
    setError(null);
    setApplyLog(null);
    try {
      const result = await updateApi.apply(packagePath.trim(), manifest, true);
      setApplyLog(result.steps);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Applying the update failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {error && (
        <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>
          {error}
        </div>
      )}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Offline update package</h2>
        <p style={{ color: '#616e7c', marginBottom: 8 }}>
          No internet connection is used - place the signed update package on disk, then check and
          apply it here.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 640 }}>
          <Input
            label="Package path"
            value={packagePath}
            onChange={(e) => setPackagePath(e.target.value)}
            placeholder="C:\path\to\release.hxpkg"
          />
          <label style={{ fontSize: 13, fontWeight: 600 }}>
            Release manifest (JSON)
            <textarea
              value={manifestJson}
              onChange={(e) => setManifestJson(e.target.value)}
              rows={6}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, marginTop: 4 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="secondary" onClick={onCheck} disabled={busy}>
              Check
            </Button>
            <Button onClick={onApply} disabled={busy || !checkResult?.readyToApply}>
              Apply Update
            </Button>
          </div>
        </div>
      </Card>

      {checkResult && (
        <Card>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Check result</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              Running version: {checkResult.runningCoreVersion} → Package version:{' '}
              {checkResult.packageVersion}
            </li>
            <li>
              Authentic:{' '}
              <StatusBadge
                label={checkResult.packageAuthentic ? 'Yes' : 'No'}
                tone={toneForBool(checkResult.packageAuthentic)}
              />{' '}
              — {checkResult.packageAuthenticityDetail}
            </li>
            <li>
              Compatible:{' '}
              <StatusBadge
                label={checkResult.compatible ? 'Yes' : 'No'}
                tone={toneForBool(checkResult.compatible)}
              />{' '}
              — {checkResult.compatibilityDetail}
            </li>
            <li>
              Disk space OK:{' '}
              <StatusBadge
                label={checkResult.diskSpaceOk ? 'Yes' : 'No'}
                tone={toneForBool(checkResult.diskSpaceOk)}
              />
            </li>
            {checkResult.migrationNotes && <li>Migration notes: {checkResult.migrationNotes}</li>}
            <li>
              Ready to apply:{' '}
              <StatusBadge
                label={checkResult.readyToApply ? 'Yes' : 'No'}
                tone={toneForBool(checkResult.readyToApply)}
              />
            </li>
          </ul>
        </Card>
      )}

      {applyLog && (
        <Card>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Apply log</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {applyLog.map((s, i) => (
              <li key={i}>
                <StatusBadge label={s.ok ? 'OK' : 'FAILED'} tone={toneForBool(s.ok)} /> {s.step}
                {s.detail ? ` — ${s.detail}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
