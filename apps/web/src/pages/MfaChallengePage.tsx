import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Input } from '@hexyrn/design-system';
import { AuthLayout } from './AuthLayout';
import { api, setCsrfToken } from '../api/client';

export function MfaChallengePage() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await api.verifyMfa(code);
      if (result.verified) {
        setCsrfToken(result.csrfToken);
        navigate('/');
      } else {
        setError('Invalid code. Try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Two-factor verification"
      subtitle="Enter the 6-digit code from your authenticator app, or a recovery code."
    >
      <form onSubmit={onSubmit}>
        <Input
          label="Authentication code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
        />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={submitting} block>
          {submitting ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
    </AuthLayout>
  );
}
