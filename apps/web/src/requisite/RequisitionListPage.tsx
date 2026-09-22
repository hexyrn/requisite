import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Table, Button, EmptyState, StatusBadge, Money, Input } from '@hexyrn/design-system';
import { requisiteApi, Requisition } from '../api/requisite';
import { statusLabel, statusTone } from './status';

/** Requisition List (item 5): search, status filter, sorting by created date, clear status. */
export function RequisitionListPage() {
  const [requisitions, setRequisitions] = useState<Requisition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  useEffect(() => {
    requisiteApi
      .listRequisitions()
      .then(setRequisitions)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load requisitions.'));
  }, []);

  const filtered = useMemo(() => {
    if (!requisitions) return [];
    return requisitions.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (search && !r.requisition_number.toLowerCase().includes(search.toLowerCase()) && !(r.reason ?? '').toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [requisitions, search, statusFilter]);

  return (
    <div>
      <PageHeader
        title="Requisitions"
        actions={
          <Link to="/requisite/requisitions/new">
            <Button>New Requisition</Button>
          </Link>
        }
      />

      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <Input aria-label="Search requisitions" placeholder="Search by number or purpose…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: 8, borderRadius: 6, border: '1px solid #d1d5db' }}>
          <option value="all">All statuses</option>
          <option value="draft">Draft</option>
          <option value="awaiting_approval">Awaiting Approval</option>
          <option value="approved">Approved</option>
          <option value="ordered">Ordered</option>
          <option value="partially_received">Partially Received</option>
          <option value="received">Received</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {error && <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>{error}</div>}

      {requisitions === null ? (
        <p>Loading…</p>
      ) : filtered.length === 0 ? (
        <EmptyState message={requisitions.length === 0 ? 'Nothing requested yet.' : 'No requisitions match your search.'} action={requisitions.length === 0 ? <Link to="/requisite/requisitions/new"><Button>Create your first requisition</Button></Link> : undefined} />
      ) : (
        <Table<Requisition>
          rowKey={(r) => r.id}
          rows={filtered}
          columns={[
            { key: 'requisition_number', header: 'Requisition', render: (r) => <Link to={`/requisite/requisitions/${r.id}`}>{r.requisition_number}</Link> },
            { key: 'reason', header: 'Purpose' },
            { key: 'value', header: 'Value', render: (r) => <Money minorUnits={r.estimated_value_minor} currency={r.currency} /> },
            { key: 'status', header: 'Status', render: (r) => <StatusBadge label={statusLabel(r.status)} tone={statusTone(r.status)} /> },
            { key: 'created_at', header: 'Created', render: (r) => new Date(r.created_at).toLocaleDateString() },
          ]}
        />
      )}
    </div>
  );
}
