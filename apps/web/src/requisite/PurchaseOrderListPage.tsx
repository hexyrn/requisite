import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, Table, EmptyState, StatusBadge, Money } from '@hexyrn/design-system';
import { requisiteApi, PurchaseOrder } from '../api/requisite';
import { statusLabel, statusTone } from './status';

/** Purchase Order List (item 10). */
export function PurchaseOrderListPage() {
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    requisiteApi
      .listPurchaseOrders()
      .then(setOrders)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load purchase orders.'));
  }, []);

  return (
    <div>
      <PageHeader title="Purchase Orders" />
      {error && <div role="alert" style={{ color: '#991b1b' }}>{error}</div>}
      {orders === null ? (
        <p>Loading…</p>
      ) : orders.length === 0 ? (
        <EmptyState message="No purchase orders have been generated yet." />
      ) : (
        <Table<PurchaseOrder>
          rowKey={(o) => o.id}
          rows={orders}
          columns={[
            { key: 'po_number', header: 'PO Number', render: (o) => <Link to={`/requisite/purchase-orders/${o.id}`}>{o.po_number}</Link> },
            { key: 'total', header: 'Total', render: (o) => <Money minorUnits={o.total_minor} currency={o.currency} /> },
            { key: 'status', header: 'Status', render: (o) => <StatusBadge label={statusLabel(o.status)} tone={statusTone(o.status)} /> },
            { key: 'expected_delivery_date', header: 'Expected Delivery', render: (o) => o.expected_delivery_date ?? '—' },
            { key: 'order_date', header: 'Order Date' },
          ]}
        />
      )}
    </div>
  );
}
