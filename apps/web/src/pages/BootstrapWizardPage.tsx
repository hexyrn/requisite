import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Card } from '@hexyrn/design-system';
import { api } from '../api/client';

const initialState = {
  token: '',
  organisationName: '',
  organisationDisplayName: '',
  defaultCurrency: 'USD',
  timezone: 'UTC',
  locale: 'en-US',
  financialYearStartMonth: 1,
  ownerEmail: '',
  ownerPassword: '',
};

export function BootstrapWizardPage() {
  const [form, setForm] = useState(initialState);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const navigate = useNavigate();

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.completeBootstrap(form);
      setDone(true);
      setTimeout(() => navigate('/login'), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div
        style={{
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Card style={{ width: 420 }}>
          <h1 style={{ fontSize: 20 }}>Setup complete</h1>
          <p>Redirecting to sign in…</p>
        </Card>
      </div>
    );
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
      <Card style={{ width: 480 }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Set up Hexyrn</h1>
        <p style={{ fontSize: 13, color: '#555', marginBottom: 16 }}>
          Enter the one-time setup token printed to the server console (or found in
          <code> bootstrap-token.txt </code> on the server) to create your organisation and owner
          account.
        </p>
        <form onSubmit={onSubmit}>
          <Input
            label="Setup token"
            name="token"
            value={form.token}
            onChange={(e) => update('token', e.target.value)}
            required
          />
          <Input
            label="Organisation name"
            name="organisationName"
            value={form.organisationName}
            onChange={(e) => update('organisationName', e.target.value)}
            required
          />
          <Input
            label="Display name"
            name="organisationDisplayName"
            value={form.organisationDisplayName}
            onChange={(e) => update('organisationDisplayName', e.target.value)}
            required
          />
          <Input
            label="Default currency (ISO 4217)"
            name="defaultCurrency"
            value={form.defaultCurrency}
            onChange={(e) => update('defaultCurrency', e.target.value)}
            required
          />
          <Input
            label="Timezone (IANA)"
            name="timezone"
            value={form.timezone}
            onChange={(e) => update('timezone', e.target.value)}
            required
          />
          <Input
            label="Locale (BCP 47)"
            name="locale"
            value={form.locale}
            onChange={(e) => update('locale', e.target.value)}
            required
          />
          <Input
            label="Owner email"
            type="email"
            name="ownerEmail"
            value={form.ownerEmail}
            onChange={(e) => update('ownerEmail', e.target.value)}
            required
          />
          <Input
            label="Owner password"
            type="password"
            name="ownerPassword"
            value={form.ownerPassword}
            onChange={(e) => update('ownerPassword', e.target.value)}
            required
          />
          {error && <p style={{ color: '#b3261e', fontSize: 13, marginBottom: 12 }}>{error}</p>}
          <Button type="submit" disabled={submitting} style={{ width: '100%' }}>
            {submitting ? 'Setting up…' : 'Complete setup'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
