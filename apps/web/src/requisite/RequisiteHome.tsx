import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Card, Button, EmptyState, StatusBadge } from '@hexyrn/design-system';
import { requisiteApi, Requisition } from '../api/requisite';
import { statusLabel, statusTone } from './status';

/**
 * Requisite Home (item 3): the landing page. Action area (drafts,
 * awaiting-my-approval) computed client-side from the requisition list -
 * a lightweight v1 approach; a future iteration should use Core Dashboard
 * widgets directly (registered in requisite-p2-extensions.ts) once the
 * dashboard-widget rendering surface exists in this frontend.
 */
export function RequisiteHome() {
  const [requisitions, setRequisitions] = useState<Requisition[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    requisiteApi
      .listRequisitions()
      .then(setRequisitions)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load requisitions.'),
      );
  }, []);

  if (error) {
    return (
      <div role="alert" style={{ color: '#991b1b', padding: 16 }}>
        Something went wrong loading your Requisite home page: {error}
      </div>
    );
  }

  const drafts = requisitions?.filter((r) => r.status === 'draft') ?? [];
  const awaitingApproval = requisitions?.filter((r) => r.status === 'awaiting_approval') ?? [];

  return (
    <div>
      <PageHeader
        title="Requisite"
        subtitle="Purchasing and procurement"
        actions={
          <Link to="/requisite/requisitions/new">
            <Button>New Requisition</Button>
          </Link>
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: 16,
        }}
      >
        <Card>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Draft requisitions</h2>
          {requisitions === null ? (
            <p>Loading…</p>
          ) : drafts.length === 0 ? (
            <EmptyState
              message="Nothing requested yet."
              action={
                <Link to="/requisite/requisitions/new">
                  <Button>Create your first requisition</Button>
                </Link>
              }
            />
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {drafts.slice(0, 5).map((r) => (
                <li key={r.id} style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                  <Link to={`/requisite/requisitions/${r.id}`}>{r.requisition_number}</Link> —{' '}
                  {r.reason}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Awaiting my approval</h2>
          {requisitions === null ? (
            <p>Loading…</p>
          ) : awaitingApproval.length === 0 ? (
            <p style={{ color: '#6b7280', fontSize: 14 }}>Nothing needs your approval right now.</p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {awaitingApproval.slice(0, 5).map((r) => (
                <li
                  key={r.id}
                  style={{
                    padding: '6px 0',
                    borderBottom: '1px solid #f3f4f6',
                    display: 'flex',
                    justifyContent: 'space-between',
                  }}
                >
                  <Link to={`/requisite/requisitions/${r.id}`}>{r.requisition_number}</Link>
                  <StatusBadge label={statusLabel(r.status)} tone={statusTone(r.status)} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
