import React, { useEffect, useState } from 'react';
import { Outlet, Link } from 'react-router-dom';
import { PageLayout, Button } from '@hexyrn/design-system';
import { api } from '../api/client';

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

  useEffect(() => {
    api
      .getOrganisation()
      .then((data) => setOrg(data as OrgSummary))
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load organisation.'),
      );
  }, []);

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
          <Button variant="secondary" onClick={onLogout}>
            Log out
          </Button>
        </div>
      }
    >
      {error && <p style={{ color: '#b3261e' }}>{error}</p>}
      <Outlet />
    </PageLayout>
  );
}
