import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { PageHeader, Card, Button, StatusBadge, Money } from '@hexyrn/design-system';
import { requisiteApi, Requisition, ApprovalHistoryEntry, Supplier } from '../api/requisite';
import { statusLabel, statusTone } from './status';

/**
 * Requisition Detail (item 7/8/36) - header + summary + lines + approval
 * (with history) + attachments + primary contextual action. Also doubles
 * as the approver's review screen (item 8) - the same page shows
 * everything an approver needs without hopping between screens.
 */
export function RequisitionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [requisition, setRequisition] = useState<Requisition | null>(null);
  const [history, setHistory] = useState<ApprovalHistoryEntry[]>([]);
  const [attachments, setAttachments] = useState<Array<{ id: string; original_filename: string }>>(
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const actionErrorRef = useRef<HTMLDivElement>(null);

  // Accessibility: the decision/submit/PO actions all live in cards further
  // down the page than this shared error banner. A screen reader hears it
  // immediately via role="alert", but a sighted keyboard/mouse user whose
  // attention is on the Reject button (say) would otherwise never see it
  // appear off-screen above. Move focus and scroll to it whenever it's set.
  useEffect(() => {
    if (actionError) {
      actionErrorRef.current?.focus();
      actionErrorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [actionError]);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [req, hist, files, sups] = await Promise.all([
        requisiteApi.getRequisition(id),
        requisiteApi.getApprovalHistory(id),
        requisiteApi.listAttachments(id),
        requisiteApi.listSuppliers(),
      ]);
      setRequisition(req);
      setHistory(hist);
      setAttachments(files);
      setSuppliers(sups);
      if (sups[0]) setSelectedSupplierId((prev) => prev || sups[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this requisition.');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function onSubmit() {
    if (!requisition) return;
    setBusy(true);
    setActionError(null);
    try {
      await requisiteApi.submitRequisition(requisition.id, requisition.version);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not submit this requisition.');
    } finally {
      setBusy(false);
    }
  }

  async function onDecide(decision: 'approve' | 'reject') {
    if (!requisition) return;
    if (decision === 'reject' && !rejectReason.trim()) {
      setActionError('Please provide a reason for rejecting this requisition.');
      return;
    }
    const pendingStep = history.flatMap((h) => h.steps).find((s) => s.status === 'pending');
    if (!pendingStep) {
      setActionError('There is no pending approval step for this requisition.');
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await requisiteApi.decideRequisition(
        requisition.id,
        pendingStep.id,
        decision,
        rejectReason || undefined,
      );
      await load();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : `Could not ${decision} this requisition.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function onGeneratePo(supplierId: string) {
    if (!requisition) return;
    setBusy(true);
    setActionError(null);
    try {
      const po = await requisiteApi.generatePurchaseOrder(requisition.id, {
        supplierId,
        lines: requisition.lines.map((l) => ({
          description: l.description,
          quantityOrdered: l.quantity,
          unitPriceMinor: l.estimated_unit_price_minor,
        })),
      });
      navigate(`/requisite/purchase-orders/${po.id}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not generate a purchase order.');
    } finally {
      setBusy(false);
    }
  }

  if (error)
    return (
      <div role="alert" style={{ color: '#991b1b' }}>
        {error}
      </div>
    );
  if (!requisition) return <p>Loading…</p>;

  const pendingStep = history.flatMap((h) => h.steps).find((s) => s.status === 'pending');

  return (
    <div>
      <PageHeader
        title={requisition.requisition_number}
        subtitle={
          <StatusBadge
            label={statusLabel(requisition.status)}
            tone={statusTone(requisition.status)}
          />
        }
        actions={
          requisition.status === 'draft' ? (
            <Button onClick={onSubmit} disabled={busy}>
              Submit for Approval
            </Button>
          ) : undefined
        }
      />

      {actionError && (
        <div
          ref={actionErrorRef}
          role="alert"
          tabIndex={-1}
          style={{ color: '#991b1b', marginBottom: 12, outline: 'none' }}
        >
          {actionError}
        </div>
      )}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Summary</h2>
        <p>{requisition.reason}</p>
        <p>
          Estimated total:{' '}
          <strong>
            <Money minorUnits={requisition.estimated_value_minor} currency={requisition.currency} />
          </strong>
        </p>
        {requisition.cost_object_reference && (
          <p>Project/cost reference: {requisition.cost_object_reference}</p>
        )}
        {requisition.required_by_date && <p>Required by: {requisition.required_by_date}</p>}
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Lines</h2>
        {requisition.lines.map((line) => (
          <div
            key={line.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '6px 0',
              borderBottom: '1px solid #f3f4f6',
            }}
          >
            <span>
              {line.quantity} {line.unit ?? ''} × {line.description}
            </span>
            <Money minorUnits={line.estimated_total_minor} currency={requisition.currency} />
          </div>
        ))}
      </Card>

      {requisition.status === 'approved' && (
        <Card>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Generate Purchase Order</h2>
          <label htmlFor="po-supplier" style={{ fontSize: 13, display: 'block', marginBottom: 4 }}>
            Supplier
          </label>
          <select
            id="po-supplier"
            value={selectedSupplierId}
            onChange={(e) => setSelectedSupplierId(e.target.value)}
            style={{
              padding: 8,
              borderRadius: 6,
              border: '1px solid #d1d5db',
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
          <div>
            <Button
              onClick={() => onGeneratePo(selectedSupplierId)}
              disabled={busy || !selectedSupplierId}
            >
              Generate Purchase Order
            </Button>
          </div>
        </Card>
      )}

      {pendingStep && (
        <Card>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Your decision</h2>
          <label
            htmlFor="reject-reason"
            style={{ fontSize: 13, display: 'block', marginBottom: 4 }}
          >
            Comment (required to reject)
          </label>
          <textarea
            id="reject-reason"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            style={{
              width: '100%',
              minHeight: 60,
              marginBottom: 12,
              padding: 8,
              borderRadius: 6,
              border: '1px solid #d1d5db',
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => onDecide('approve')} disabled={busy}>
              Approve
            </Button>
            <Button variant="danger" onClick={() => onDecide('reject')} disabled={busy}>
              Reject
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Approval history</h2>
        {history.length === 0 ||
        history.every((h) => h.steps.every((s) => s.decisions.length === 0)) ? (
          <p style={{ color: '#6b7280', fontSize: 14 }}>No decisions have been recorded yet.</p>
        ) : (
          history
            .flatMap((h) => h.steps)
            .flatMap((s) => s.decisions)
            .map((d, i) => (
              <div
                key={i}
                style={{ padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 14 }}
              >
                {d.decision === 'approve' ? 'Approved' : 'Rejected'} on{' '}
                {new Date(d.decided_at).toLocaleString()}
                {d.comment && <div style={{ color: '#6b7280' }}>"{d.comment}"</div>}
              </div>
            ))
        )}
      </Card>

      <Card>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Documents</h2>
        {attachments.length === 0 ? (
          <p style={{ color: '#6b7280', fontSize: 14 }}>No files attached.</p>
        ) : (
          <ul>
            {attachments.map((a) => (
              <li key={a.id}>{a.original_filename}</li>
            ))}
          </ul>
        )}
      </Card>

      <Link to="/requisite/requisitions">← Back to Requisitions</Link>
    </div>
  );
}
