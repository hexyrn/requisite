import React, { useState } from 'react';
import { Alert, Button, Card, Input, PageHeader } from '@hexyrn/design-system';
import { securityApi } from '../api/admin';

/** Two-factor authentication for the signed-in user: scan/enter the key in an authenticator app, confirm a code, keep the recovery codes. */
export function AccountSecurityPage() {
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setEnrolment(await securityApi.beginMfa());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start two-factor setup.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (!enrolment) return;
    setBusy(true);
    setError(null);
    try {
      const result = await securityApi.confirmMfa(enrolment.secret, code.trim());
      setRecoveryCodes(result.recoveryCodes);
      setEnrolment(null);
      setCode('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Account security"
        subtitle="Protect your sign-in with two-factor authentication."
      />
      {error && <Alert>{error}</Alert>}
      {recoveryCodes && (
        <Alert tone="success">
          <strong>Two-factor authentication is on.</strong> Save these recovery codes somewhere
          safe. Each works once if you lose your authenticator, and they are shown only now:
          <pre data-testid="recovery-codes">{recoveryCodes.join('\n')}</pre>
        </Alert>
      )}
      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Two-factor authentication</h2>
        {!enrolment ? (
          <Button onClick={begin} disabled={busy}>
            {recoveryCodes ? 'Set up again' : 'Set up two-factor authentication'}
          </Button>
        ) : (
          <form onSubmit={confirm} style={{ maxWidth: 520 }}>
            <p>
              In your authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…)
              add an account and enter this key manually:
            </p>
            <p>
              <code data-testid="mfa-secret" style={{ fontSize: 16, wordBreak: 'break-all' }}>
                {enrolment.secret}
              </code>
            </p>
            <p className="hx-muted" style={{ fontSize: 13 }}>
              On a phone, <a href={enrolment.otpauthUrl}>tap here</a> to add it automatically.
            </p>
            <Input
              label="6-digit code from the app"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
            <Button type="submit" disabled={busy || !code.trim()}>
              Turn on
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
