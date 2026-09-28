import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Input } from '@hexyrn/design-system';
import { AuthLayout } from './AuthLayout';
import { securityApi } from '../api/admin';

/** An invited person chooses their password from the one-time link the administrator sent. */
export function AcceptInvitationPage() {
  const token = useMemo(() => new URLSearchParams(window.location.search).get('token') ?? '', []);
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await securityApi.acceptInvitation(token, password);
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'This invitation is not valid any more.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Welcome" subtitle="Choose a password to finish creating your account.">
      {done ? (
        <p>
          Your account is ready. <Link to="/login">Sign in</Link>
        </p>
      ) : !token ? (
        <Alert>This link is incomplete. Ask your administrator for a new invitation.</Alert>
      ) : (
        <form onSubmit={onSubmit}>
          <Input
            label="Password (at least 12 characters)"
            type="password"
            name="password"
            autoComplete="new-password"
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" disabled={busy} block>
            {busy ? 'Saving…' : 'Create my account'}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
