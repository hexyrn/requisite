import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Input } from '@hexyrn/design-system';
import { AuthLayout } from './AuthLayout';
import { api, setCsrfToken } from '../api/client';
import { COMMON_CURRENCIES, guessRegionDefaults, readTokenFromHash } from './regionDefaults';

/**
 * First-run setup. On a Windows install the Start Menu launcher opens this page with the one-time
 * setup code already in the URL fragment, so the customer is asked only for what nobody else can know:
 * the organisation name and the owner's email and password. Regional settings are pre-filled from the
 * browser and can be changed under "Regional settings". When setup succeeds the owner is signed in
 * automatically and taken straight to licence activation.
 */
export function BootstrapWizardPage() {
  const defaults = useMemo(() => guessRegionDefaults(), []);
  const tokenFromLink = useMemo(() => readTokenFromHash(window.location.hash), []);
  const [token, setToken] = useState(tokenFromLink);
  const [organisationName, setOrganisationName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPassword, setOwnerPassword] = useState('');
  const [region, setRegion] = useState(defaults);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.completeBootstrap({
        token: token.trim(),
        organisationName: organisationName.trim(),
        organisationDisplayName: organisationName.trim(),
        ownerEmail: ownerEmail.trim(),
        ownerPassword,
        ...region,
      });
      // The setup code has done its job - do not leave it in the address bar / history.
      window.history.replaceState(null, '', window.location.pathname);
      // Sign the new owner in and continue to licence activation: no extra sign-in step.
      const login = await api.login(ownerEmail.trim(), ownerPassword);
      setCsrfToken(login.csrfToken);
      navigate('/admin/licence?firstRun=1', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Set up Requisite"
      width={520}
      subtitle="Create your organisation and the owner account. This takes a minute."
    >
      <form onSubmit={onSubmit}>
        {!tokenFromLink && (
          <Input
            label="Setup code"
            name="token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoComplete="off"
          />
        )}
        {!tokenFromLink && (
          <p className="hx-muted" style={{ marginTop: -4, fontSize: 13 }}>
            Open <strong>Requisite</strong> from the Start Menu and this page fills the code in for
            you.
          </p>
        )}
        <Input
          label="Organisation name"
          name="organisationName"
          autoFocus
          value={organisationName}
          onChange={(e) => setOrganisationName(e.target.value)}
          required
        />
        <Input
          label="Owner email"
          type="email"
          name="ownerEmail"
          autoComplete="username"
          value={ownerEmail}
          onChange={(e) => setOwnerEmail(e.target.value)}
          required
        />
        <Input
          label="Owner password (at least 12 characters)"
          type="password"
          name="ownerPassword"
          autoComplete="new-password"
          minLength={12}
          value={ownerPassword}
          onChange={(e) => setOwnerPassword(e.target.value)}
          required
        />
        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>
            Regional settings ({region.defaultCurrency}, {region.timezone})
          </summary>
          <div style={{ marginTop: 12 }}>
            <div className="hx-field">
              <label htmlFor="defaultCurrency">Currency</label>
              <select
                id="defaultCurrency"
                value={region.defaultCurrency}
                onChange={(e) => setRegion({ ...region, defaultCurrency: e.target.value })}
              >
                {[...new Set([region.defaultCurrency, ...COMMON_CURRENCIES])].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <Input
              label="Time zone"
              name="timezone"
              value={region.timezone}
              onChange={(e) => setRegion({ ...region, timezone: e.target.value })}
            />
            <Input
              label="Language / locale"
              name="locale"
              value={region.locale}
              onChange={(e) => setRegion({ ...region, locale: e.target.value })}
            />
            <div className="hx-field">
              <label htmlFor="fyMonth">Financial year starts in</label>
              <select
                id="fyMonth"
                value={region.financialYearStartMonth}
                onChange={(e) =>
                  setRegion({ ...region, financialYearStartMonth: Number(e.target.value) })
                }
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {new Date(2000, i, 1).toLocaleString('en', { month: 'long' })}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </details>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={submitting} block>
          {submitting ? 'Setting up…' : 'Create organisation'}
        </Button>
      </form>
    </AuthLayout>
  );
}
