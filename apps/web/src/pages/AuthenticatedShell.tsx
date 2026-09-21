import React, { useEffect, useState } from 'react';
import { PageLayout, Button } from '@hexyrn/design-system';
import { api } from '../api/client';

interface OrgSummary {
  display_name: string;
}

export function AuthenticatedShell() {
  const [org, setOrg] = useState<OrgSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getOrganisation()
      .then((data) => setOrg(data as OrgSummary))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load organisation.'));
  }, []);

  async function onLogout() {
    await api.logout().catch(() => undefined);
    window.location.href = '/login';
  }

  return (
    <PageLayout
      title="Dashboard"
      orgName={org?.display_name}
      nav={
        <Button variant="secondary" onClick={onLogout}>
          Log out
        </Button>
      }
    >
      {error && <p style={{ color: '#b3261e' }}>{error}</p>}
      <p>
        This is the P0 application shell. Business apps (Requisite, Assets, Maintain, Competency,
        Margin) are not part of Core and are not built here - this shell exists only to prove the
        authenticated session, organisation context, and design-system primitives work end to end.
      </p>
    </PageLayout>
  );
}
