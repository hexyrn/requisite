import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader, Table, Button, EmptyState, StatusBadge } from '@hexyrn/design-system';
import { requisiteApi, Rfq } from '../api/requisite';
import { statusLabel, statusTone } from './status';

/** RFQ/Quote list (item 9). */
export function RfqListPage() {
  const navigate = useNavigate();
  const [rfqs, setRfqs] = useState<Rfq[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  function reload() {
    requisiteApi
      .listRfqs()
      .then(setRfqs)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load RFQs.'));
  }

  useEffect(reload, []);

  async function onNewRfq() {
    setCreating(true);
    setError(null);
    try {
      const rfq = await requisiteApi.createRfq();
      navigate(`/requisite/rfqs/${rfq.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create an RFQ.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Quotes/RFQs"
        actions={
          <Button onClick={onNewRfq} disabled={creating}>
            New RFQ
          </Button>
        }
      />
      {error && <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>{error}</div>}
      {rfqs === null ? (
        <p>Loading…</p>
      ) : rfqs.length === 0 ? (
        <EmptyState message="No RFQs have been created yet." action={<Button onClick={onNewRfq}>Create your first RFQ</Button>} />
      ) : (
        <Table<Rfq>
          rowKey={(r) => r.id}
          rows={rfqs}
          columns={[
            { key: 'rfq_number', header: 'RFQ', render: (r) => <Link to={`/requisite/rfqs/${r.id}`}>{r.rfq_number}</Link> },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge label={statusLabel(r.status)} tone={statusTone(r.status)} /> },
            { key: 'created_at', header: 'Created', render: (r) => new Date(r.created_at).toLocaleDateString() },
          ]}
        />
      )}
    </div>
  );
}
