import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Card } from '@hexyrn/design-system';
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
    <div
      style={{
        display: 'flex',
        minHeight: '100vh',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card style={{ width: 360 }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Two-factor verification</h1>
        <p style={{ fontSize: 13, color: '#555', marginBottom: 16 }}>
          Enter the 6-digit code from your authenticator app.
        </p>
        <form onSubmit={onSubmit}>
          <Input
            label="Authentication code"
            name="code"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          {error && <p style={{ color: '#b3261e', fontSize: 13, marginBottom: 12 }}>{error}</p>}
          <Button type="submit" disabled={submitting} style={{ width: '100%' }}>
            {submitting ? 'Verifying…' : 'Verify'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
