import React, { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  PageHeader,
  Card,
  Button,
  Input,
  StatusBadge,
  Money,
  EmptyState,
} from '@hexyrn/design-system';
import { requisiteApi, RfqDetail, Supplier, QuoteLineInput } from '../api/requisite';
import { statusLabel, statusTone } from './status';

interface DraftQuoteLine extends QuoteLineInput {
  key: string;
}

function emptyLine(): DraftQuoteLine {
  return { key: crypto.randomUUID(), description: '', quantity: '1', unitPriceMinor: '0' };
}

/**
 * RFQ detail + comparison (item 9). Suppliers as rows, with quoted total/
 * carriage/expiry/notes visible side by side to ease human decision-
 * making. The system NEVER auto-selects a winner - selection is always
 * an explicit click, with an optional reason, and the previously-
 * selected quote (if any) is demoted server-side.
 */
export function RfqDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [rfq, setRfq] = useState<RfqDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [busy, setBusy] = useState(false);

  // New quote form state.
  const [supplierId, setSupplierId] = useState('');
  const [quoteReference, setQuoteReference] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [carriageMinor, setCarriageMinor] = useState('0');
  const [lines, setLines] = useState<DraftQuoteLine[]>([emptyLine()]);
  const [selectionReason, setSelectionReason] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [detail, sups] = await Promise.all([
        requisiteApi.getRfq(id),
        requisiteApi.listSuppliers(),
      ]);
      setRfq(detail);
      setSuppliers(sups);
      if (sups[0]) setSupplierId((prev) => prev || sups[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this RFQ.');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function onRecordQuote() {
    if (!rfq) return;
    if (lines.some((l) => !l.description.trim())) {
      setActionError('Every line needs a description.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await requisiteApi.recordQuote(rfq.id, {
        supplierId,
        quoteReference: quoteReference || undefined,
        expiryDate: expiryDate || undefined,
        carriageMinor,
        lines: lines.map(({ key: _key, ...rest }) => rest),
      });
      setLines([emptyLine()]);
      setQuoteReference('');
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not record this quotation.');
    } finally {
      setBusy(false);
    }
  }

  async function onSelect(quoteId: string) {
    if (!rfq) return;
    setBusy(true);
    setActionError(null);
    try {
      await requisiteApi.selectQuote(rfq.id, quoteId, selectionReason || undefined);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not select this quotation.');
    } finally {
      setBusy(false);
    }
  }

  async function onReject(quoteId: string) {
    if (!rfq) return;
    setBusy(true);
    setActionError(null);
    try {
      await requisiteApi.rejectQuote(rfq.id, quoteId);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not reject this quotation.');
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
  if (!rfq) return <p>Loading…</p>;

  return (
    <div>
      <PageHeader
        title={rfq.rfq_number}
        subtitle={<StatusBadge label={statusLabel(rfq.status)} tone={statusTone(rfq.status)} />}
      />
      {actionError && (
        <div role="alert" style={{ color: 'var(--hx-danger)', marginBottom: 12 }}>
          {actionError}
        </div>
      )}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Quote Comparison</h2>
        {rfq.quotes.length === 0 ? (
          <EmptyState message="No quotations have been recorded yet." />
        ) : (
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Supplier</th>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Reference</th>
                <th style={{ textAlign: 'right', padding: '4px 8px' }}>Carriage</th>
                <th style={{ textAlign: 'right', padding: '4px 8px' }}>Total</th>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Expiry</th>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Status</th>
                <th style={{ textAlign: 'left', padding: '4px 8px' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rfq.quotes.map((q) => (
                <tr key={q.id} style={{ borderTop: '1px solid var(--hx-border)' }}>
                  <td style={{ padding: '4px 8px' }}>{q.supplier_name}</td>
                  <td style={{ padding: '4px 8px' }}>{q.quote_reference ?? '—'}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                    <Money minorUnits={q.carriage_minor} currency={q.currency} />
                  </td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                    <Money minorUnits={q.total_minor} currency={q.currency} />
                  </td>
                  <td style={{ padding: '4px 8px' }}>{q.expiry_date ?? '—'}</td>
                  <td style={{ padding: '4px 8px' }}>
                    <StatusBadge label={statusLabel(q.status)} tone={statusTone(q.status)} />
                    {q.selection_reason && (
                      <div style={{ fontSize: 12, color: 'var(--hx-text-muted)' }}>
                        "{q.selection_reason}"
                      </div>
                    )}
                  </td>
                  <td style={{ padding: '4px 8px' }}>
                    {q.status === 'received' && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Button
                          onClick={() => onSelect(q.id)}
                          disabled={busy}
                          aria-label={`Select quote from ${q.supplier_name}`}
                        >
                          Select
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => onReject(q.id)}
                          disabled={busy}
                          aria-label={`Reject quote from ${q.supplier_name}`}
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rfq.quotes.some((q) => q.status === 'received') && (
          <div style={{ marginTop: 12 }}>
            <Input
              label="Selection reason (optional)"
              value={selectionReason}
              onChange={(e) => setSelectionReason(e.target.value)}
              placeholder="e.g. Best price and delivery time"
            />
          </div>
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Record a Quotation</h2>
        <label htmlFor="quote-supplier" style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>
          Supplier
        </label>
        <select
          id="quote-supplier"
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          style={{
            marginBottom: 12,
            minWidth: 240,
          }}
        >
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}
        >
          <Input
            label="Quote reference"
            value={quoteReference}
            onChange={(e) => setQuoteReference(e.target.value)}
          />
          <Input
            label="Expiry date"
            type="date"
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
          />
          <Input
            label="Carriage (pence)"
            type="number"
            min="0"
            value={carriageMinor}
            onChange={(e) => setCarriageMinor(e.target.value)}
          />
        </div>

        {lines.map((line, idx) => (
          <div
            key={line.key}
            style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 1fr', gap: 8, marginBottom: 8 }}
          >
            <Input
              label={idx === 0 ? 'Description' : undefined}
              aria-label="Quote line description"
              value={line.description}
              onChange={(e) =>
                setLines((prev) =>
                  prev.map((l) => (l.key === line.key ? { ...l, description: e.target.value } : l)),
                )
              }
            />
            <Input
              label={idx === 0 ? 'Quantity' : undefined}
              aria-label="Quote line quantity"
              type="number"
              value={line.quantity}
              onChange={(e) =>
                setLines((prev) =>
                  prev.map((l) => (l.key === line.key ? { ...l, quantity: e.target.value } : l)),
                )
              }
            />
            <Input
              label={idx === 0 ? 'Unit price (pence)' : undefined}
              aria-label="Quote line unit price in pence"
              type="number"
              value={line.unitPriceMinor}
              onChange={(e) =>
                setLines((prev) =>
                  prev.map((l) =>
                    l.key === line.key ? { ...l, unitPriceMinor: e.target.value } : l,
                  ),
                )
              }
            />
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          onClick={() => setLines((prev) => [...prev, emptyLine()])}
        >
          + Add line
        </Button>
        <div style={{ marginTop: 12 }}>
          <Button onClick={onRecordQuote} disabled={busy}>
            Record Quotation
          </Button>
        </div>
      </Card>

      <Link to="/requisite/rfqs">← Back to Quotes/RFQs</Link>
    </div>
  );
}
