import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader, EmptyState, Table } from '@hexyrn/design-system';
import { requisiteApi, PurchaseOrder } from '../api/requisite';

/**
 * Goods Receipts (item 13) - a simple index over purchase orders that
 * have at least one receipt, since receipts are always viewed in the
 * context of their PO. Each PO's own detail page shows every receipt
 * against it (item 13's "PO detail screen shows every receipt").
 */
export function GoodsReceiptListPage() {
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    requisiteApi
      .listPurchaseOrders()
      .then((all) =>
        setOrders(
          all.filter(
            (o) =>
              o.status === 'partially_received' ||
              o.status === 'received' ||
              o.status === 'completed',
          ),
        ),
      )
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load goods receipts.'),
      );
  }, []);

  return (
    <div>
      <PageHeader
        title="Goods Receipts"
        subtitle="Purchase orders with at least one recorded delivery"
      />
      {error && (
        <div role="alert" style={{ color: '#991b1b' }}>
          {error}
        </div>
      )}
      {orders === null ? (
        <p>Loading…</p>
      ) : orders.length === 0 ? (
        <EmptyState message="No deliveries have been recorded against any order yet." />
      ) : (
        <Table<PurchaseOrder>
          rowKey={(o) => o.id}
          rows={orders}
          columns={[
            {
              key: 'po_number',
              header: 'Purchase Order',
              render: (o) => <Link to={`/requisite/purchase-orders/${o.id}`}>{o.po_number}</Link>,
            },
            { key: 'status', header: 'Status' },
          ]}
        />
      )}
    </div>
  );
}
