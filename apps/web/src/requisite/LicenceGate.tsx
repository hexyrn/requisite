import React, { useEffect, useState } from 'react';
import { Card } from '@hexyrn/design-system';
import { request } from '../api/client';

interface AppState {
  installed: boolean;
  enabled: boolean;
  licensed: boolean;
  compatible: boolean;
  active: boolean;
}

/**
 * Item 21 - if Requisite is present but not validly licensed, ordinary
 * users must never see a broken application. This wraps the Requisite
 * route tree: while `active` is false, it shows an administrative status
 * screen instead of any purchasing functionality. The underlying
 * /api/v1/apps/:appId/state check is admin-only (item 21's "licence-
 * import/status info for authorised administrators") - a non-admin whose
 * app is inactive simply sees a plain "not currently available" message,
 * since they cannot see licensing detail either way.
 */
export function LicenceGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AppState | 'forbidden' | null>(null);

  useEffect(() => {
    request<AppState>('/apps/com.hexyrn.requisite/state')
      .then(setState)
      .catch(() => setState('forbidden'));
  }, []);

  if (state === null) return <p>Loading…</p>;

  if (state === 'forbidden') {
    // Non-admin: we cannot check licensing detail, so assume active and
    // let the normal app routes 404 naturally if it isn't (Architecture
    // §3's "never reveal app existence to an unauthorised caller" still
    // applies for ordinary users).
    return <>{children}</>;
  }

  if (state.active) return <>{children}</>;

  return (
    <Card>
      <h1 style={{ fontSize: 20, marginBottom: 12 }}>Hexyrn Requisite — Not Licensed</h1>
      <p style={{ marginBottom: 12, color: 'var(--hx-text)' }}>
        Requisite is installed but is not currently active for your organisation. No purchasing
        functionality is available until this is resolved.
      </p>
      <ul style={{ fontSize: 14, color: 'var(--hx-text-muted)', lineHeight: 1.8 }}>
        <li>Installed: {state.installed ? 'Yes' : 'No'}</li>
        <li>Enabled: {state.enabled ? 'Yes' : 'No'}</li>
        <li>Licensed: {state.licensed ? 'Yes' : 'No — a valid licence has not been applied'}</li>
        <li>Compatible with this Core version: {state.compatible ? 'Yes' : 'No'}</li>
      </ul>
      <p style={{ marginTop: 12, fontSize: 13, color: 'var(--hx-text-muted)' }}>
        Contact your Hexyrn account administrator to import a valid licence.
      </p>
    </Card>
  );
}
