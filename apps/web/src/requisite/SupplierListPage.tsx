import React, { useEffect, useState } from 'react';
import { PageHeader, Table, Button, EmptyState, Input, Card } from '@hexyrn/design-system';
import { requisiteApi, Supplier } from '../api/requisite';

/** Suppliers (item 14) - list, quick-add. Not a CRM. */
export function SupplierListPage() {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [creating, setCreating] = useState(false);

  function reload() {
    requisiteApi
      .listSuppliers()
      .then(setSuppliers)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load suppliers.'));
  }

  useEffect(reload, []);

  async function onAdd() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await requisiteApi.createSupplier({ name, email: email || undefined });
      setName('');
      setEmail('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this supplier.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <PageHeader title="Suppliers" />
      {error && (
        <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>
          {error}
        </div>
      )}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Add Supplier</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button onClick={onAdd} disabled={creating || !name.trim()}>
            Add Supplier
          </Button>
        </div>
      </Card>

      {suppliers === null ? (
        <p>Loading…</p>
      ) : suppliers.length === 0 ? (
        <EmptyState message="No suppliers have been added." />
      ) : (
        <Table<Supplier>
          rowKey={(s) => s.id}
          rows={suppliers}
          columns={[
            { key: 'supplier_number', header: 'Supplier #' },
            { key: 'name', header: 'Name' },
            { key: 'email', header: 'Email', render: (s) => s.email ?? '—' },
            { key: 'status', header: 'Status' },
          ]}
        />
      )}
    </div>
  );
}
