import React, { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { PageHeader, Card, Button, StatusBadge, Money, Input } from '@hexyrn/design-system';
import { requisiteApi, PurchaseOrder, GoodsReceipt } from '../api/requisite';
import { statusLabel, statusTone } from './status';

/**
 * Purchase Order Detail (item 11/12/13) - status-contextual actions
 * (Issue / Record Goods Receipt / Record Remaining Delivery), a PDF
 * download link, and inline goods-receipt recording with
 * Ordered|Received|Outstanding per line (item 12), defaulting "receive
 * now" to the full outstanding quantity but editable, with UI-level
 * over-receipt prevention (input max) backed by the real DB constraint.
 */
export function PurchaseOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [po, setPo] = useState<PurchaseOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receiveQuantities, setReceiveQuantities] = useState<Record<string, string>>({});
  const [deliveryNoteRef, setDeliveryNoteRef] = useState('');
  const [receipts, setReceipts] = useState<GoodsReceipt[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [order, poReceipts] = await Promise.all([
        requisiteApi.getPurchaseOrder(id),
        requisiteApi.listGoodsReceiptsForPo(id),
      ]);
      setPo(order);
      setReceipts(poReceipts);
      const defaults: Record<string, string> = {};
      for (const line of order.lines) {
        const outstanding = Number(line.quantity_ordered) - Number(line.quantity_received);
        defaults[line.id] = outstanding > 0 ? String(outstanding) : '0';
      }
      setReceiveQuantities(defaults);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this purchase order.');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function onIssue() {
    if (!po) return;
    setBusy(true);
    setActionError(null);
    try {
      await requisiteApi.issuePurchaseOrder(po.id, po.version);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not issue this purchase order.');
    } finally {
      setBusy(false);
    }
  }

  async function onRecordReceipt() {
    if (!po) return;
    const lines = po.lines
      .map((line) => ({
        purchaseOrderLineId: line.id,
        quantityReceived: receiveQuantities[line.id] ?? '0',
      }))
      .filter((l) => Number(l.quantityReceived) > 0);
    if (lines.length === 0) {
      setActionError('Enter a quantity to receive for at least one line.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await requisiteApi.recordGoodsReceipt(po.id, {
        lines,
        deliveryNoteReference: deliveryNoteRef || undefined,
      });
      setDeliveryNoteRef('');
      await load();
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : 'Could not record this goods receipt - check the quantity does not exceed what is outstanding.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return (
      <div role="alert" style={{ color: 'var(--hx-danger)' }}>
        {error}
      </div>
    );
  if (!po) return <p>Loading…</p>;

  const canReceive = po.status === 'issued' || po.status === 'partially_received';

  return (
    <div>
      <PageHeader
        title={po.po_number}
        subtitle={<StatusBadge label={statusLabel(po.status)} tone={statusTone(po.status)} />}
        actions={
          <>
            {po.status === 'draft' && (
              <Button onClick={onIssue} disabled={busy}>
                Issue Purchase Order
              </Button>
            )}
            <a
              href={`/api/v1/requisite/purchase-orders/${po.id}/document.pdf`}
              target="_blank"
              rel="noreferrer"
            >
              <Button variant="secondary">View PDF</Button>
            </a>
          </>
        }
      />

      {actionError && (
        <div role="alert" style={{ color: 'var(--hx-danger)', marginBottom: 12 }}>
          {actionError}
        </div>
      )}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Summary</h2>
        <p>
          Total:{' '}
          <strong>
            <Money minorUnits={po.total_minor} currency={po.currency} />
          </strong>{' '}
          (net <Money minorUnits={po.subtotal_minor} currency={po.currency} />, tax{' '}
          <Money minorUnits={po.tax_minor} currency={po.currency} />)
        </p>
        {po.expected_delivery_date && <p>Expected delivery: {po.expected_delivery_date}</p>}
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Lines</h2>
        <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '4px 8px' }}>Description</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Ordered</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Received</th>
              <th style={{ textAlign: 'right', padding: '4px 8px' }}>Outstanding</th>
              {canReceive && (
                <th style={{ textAlign: 'right', padding: '4px 8px' }}>Receive Now</th>
              )}
            </tr>
          </thead>
          <tbody>
            {po.lines.map((line) => {
              const outstanding = Number(line.quantity_ordered) - Number(line.quantity_received);
              return (
                <tr key={line.id} style={{ borderTop: '1px solid var(--hx-border)' }}>
                  <td style={{ padding: '4px 8px' }}>{line.description}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                    {line.quantity_ordered}
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                    {line.quantity_received}
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{outstanding}</td>
                  {canReceive && (
                    <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                      <input
                        aria-label={`Receive now for ${line.description}`}
                        type="number"
                        min={0}
                        max={outstanding}
                        value={receiveQuantities[line.id] ?? '0'}
                        onChange={(e) =>
                          setReceiveQuantities((prev) => ({ ...prev, [line.id]: e.target.value }))
                        }
                        style={{
                          width: 70,
                          padding: 4,
                          borderRadius: 4,
                          border: '1px solid var(--hx-border-strong)',
                        }}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        {canReceive && (
          <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--hx-border)' }}>
            <Input
              label="Delivery note reference"
              value={deliveryNoteRef}
              onChange={(e) => setDeliveryNoteRef(e.target.value)}
            />
            <Button onClick={onRecordReceipt} disabled={busy}>
              {po.status === 'partially_received'
                ? 'Record Remaining Delivery'
                : 'Record Goods Receipt'}
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Goods Receipt History</h2>
        {receipts.length === 0 ? (
          <p style={{ color: 'var(--hx-text-muted)', fontSize: 14 }}>
            No deliveries have been recorded against this order.
          </p>
        ) : (
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>GRN</th>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Date</th>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Delivery Note</th>
                <th style={{ textAlign: 'right', padding: '4px 8px' }}>Lines</th>
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--hx-border)' }}>
                  <td style={{ padding: '4px 8px' }}>{r.grn_number}</td>
                  <td style={{ padding: '4px 8px' }}>{new Date(r.received_at).toLocaleString()}</td>
                  <td style={{ padding: '4px 8px' }}>{r.delivery_note_reference ?? '—'}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{r.lines?.length ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Link to="/requisite/purchase-orders">← Back to Purchase Orders</Link>
    </div>
  );
}
