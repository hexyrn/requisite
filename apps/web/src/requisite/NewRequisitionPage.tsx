import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHeader, Card, Button, Input, Money } from '@hexyrn/design-system';
import { requisiteApi, RequisitionLineInput } from '../api/requisite';

interface DraftLine extends RequisitionLineInput {
  key: string;
}

function emptyLine(): DraftLine {
  return { key: crypto.randomUUID(), description: '', quantity: '1', estimatedUnitPriceMinor: '0' };
}

/**
 * New Requisition (item 6) - the most important screen. Progressive
 * disclosure: category/cost-reference/required-by are optional and
 * de-emphasised below the primary purpose+lines flow. All totals shown
 * here are DISPLAY-ONLY conveniences computed in JS - the backend
 * recomputes the authoritative total server-side from bigint minor units
 * (item 6/38); this UI never submits a client-computed total.
 */
export function NewRequisitionPage() {
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('');
  const [requiredByDate, setRequiredByDate] = useState('');
  const [costObjectReference, setCostObjectReference] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const estimatedTotalMinor = lines.reduce((sum, line) => {
    const qty = Number(line.quantity) || 0;
    const price = Number(line.estimatedUnitPriceMinor) || 0;
    return sum + Math.round(qty * price);
  }, 0);

  function updateLine(key: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()]);
  }

  function removeLine(key: string) {
    setLines((prev) => (prev.length > 1 ? prev.filter((l) => l.key !== key) : prev));
  }

  async function onSaveDraft() {
    setValidationError(null);
    if (!reason.trim()) {
      setValidationError('Please explain what this requisition is for.');
      return;
    }
    if (lines.some((l) => !l.description.trim())) {
      setValidationError('Every line needs a description.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await requisiteApi.createRequisition({
        reason,
        category: category || undefined,
        requiredByDate: requiredByDate || undefined,
        costObjectReference: costObjectReference || undefined,
        lines: lines.map(({ key: _key, ...rest }) => rest),
      });
      navigate(`/requisite/requisitions/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this requisition. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader title="New Requisition" subtitle="Tell us what you need and we'll route it for approval." />

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Purpose</h2>
        <Input label="What do you need, and why?" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Replacement steel brackets for the Coventry production line" />

        <details style={{ marginTop: 8, marginBottom: 16 }}>
          <summary style={{ cursor: 'pointer', fontSize: 13, color: '#374151' }}>More details (optional)</summary>
          <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Input label="Category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Materials" />
            <Input label="Required by" type="date" value={requiredByDate} onChange={(e) => setRequiredByDate(e.target.value)} />
            <Input label="Project / cost reference" value={costObjectReference} onChange={(e) => setCostObjectReference(e.target.value)} placeholder="e.g. JOB-4471" />
          </div>
        </details>
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>What are you purchasing?</h2>
        {lines.map((line, idx) => (
          <div key={line.key} style={{ display: 'grid', gridTemplateColumns: '3fr 1fr 1fr 1fr auto', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
            <Input label={idx === 0 ? 'Description' : undefined} aria-label="Line description" value={line.description} onChange={(e) => updateLine(line.key, { description: e.target.value })} />
            <Input label={idx === 0 ? 'Quantity' : undefined} aria-label="Quantity" type="number" min="0" value={line.quantity} onChange={(e) => updateLine(line.key, { quantity: e.target.value })} />
            <Input label={idx === 0 ? 'Unit' : undefined} aria-label="Unit" value={line.unit ?? ''} onChange={(e) => updateLine(line.key, { unit: e.target.value })} />
            <Input label={idx === 0 ? 'Est. unit price (pence)' : undefined} aria-label="Estimated unit price in pence" type="number" min="0" value={line.estimatedUnitPriceMinor} onChange={(e) => updateLine(line.key, { estimatedUnitPriceMinor: e.target.value })} />
            <Button type="button" onClick={() => removeLine(line.key)} aria-label={`Remove line ${idx + 1}`}>
              Remove
            </Button>
          </div>
        ))}
        <Button type="button" onClick={addLine}>
          + Add line
        </Button>

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid #e5e7eb', textAlign: 'right', fontSize: 16 }}>
          Estimated total: <strong><Money minorUnits={estimatedTotalMinor} /></strong>
        </div>
      </Card>

      {validationError && <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>{validationError}</div>}
      {error && <div role="alert" style={{ color: '#991b1b', marginBottom: 12 }}>{error}</div>}

      <Button onClick={onSaveDraft} disabled={submitting}>
        {submitting ? 'Saving…' : 'Save Draft'}
      </Button>
    </div>
  );
}
