import React, { useEffect, useState } from 'react';
import { Outlet, Link, useNavigate } from 'react-router-dom';
import { PageLayout, Button } from '@hexyrn/design-system';
import { api, ApiError, setCsrfToken } from '../api/client';

interface OrgSummary {
  display_name: string;
}

/**
 * Application shell. Business apps (Requisite, Assets, Maintain,
 * Competency, Margin) register their own routes beneath this shell via
 * <Outlet/> - the shell itself only proves the authenticated session,
 * organisation context, and top-level navigation.
 */
export function AuthenticatedShell() {
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Nothing behind the shell may render (or fire requests) until we know the
  // visitor has a valid session; otherwise a logged-out user sees a blank page.
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The CSRF token lives only in memory, so after a refresh / new tab it
        // must be re-fetched before any state-changing request can succeed.
        const session = await api.getSession();
        if (cancelled) return;
        setCsrfToken(session.csrfToken);
        setReady(true);
        const data = await api.getOrganisation();
        if (!cancelled) setOrg(data as OrgSummary);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate('/login', { replace: true });
          return;
        }
        setReady(true);
        setError(err instanceof Error ? err.message : 'Failed to load organisation.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function onLogout() {
    await api.logout().catch(() => undefined);
    window.location.href = '/login';
  }

  return (
    <PageLayout
      title=""
      orgName={org?.display_name}
      nav={
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <Link to="/requisite" style={{ color: '#fff' }}>
            Requisite
          </Link>
          <Link to="/admin" style={{ color: '#fff' }}>
            Admin
          </Link>
          <Button variant="secondary" onClick={onLogout}>
            Log out
          </Button>
        </div>
      }
    >
      {error && <p style={{ color: '#b3261e' }}>{error}</p>}
      {ready ? <Outlet /> : <p>Loading…</p>}
    </PageLayout>
  );
}
