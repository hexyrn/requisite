import type { StatusTone } from '@hexyrn/design-system';

/**
 * Maps raw backend status strings to human-readable labels and a visual
 * tone - the ONE place Requisite UI translates domain status into
 * something a purchasing user reads, so raw values like
 * "awaiting_approval" or "partially_received" never leak into the UI
 * verbatim (item 2/34).
 */
const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  awaiting_approval: 'Awaiting Approval',
  approved: 'Approved',
  rejected: 'Rejected',
  ordered: 'Ordered',
  partially_received: 'Partially Received',
  received: 'Received',
  closed: 'Closed',
  cancelled: 'Cancelled',
  issued: 'Issued',
  completed: 'Completed',
};

const STATUS_TONES: Record<string, StatusTone> = {
  draft: 'neutral',
  submitted: 'info',
  awaiting_approval: 'warning',
  approved: 'success',
  rejected: 'danger',
  ordered: 'info',
  partially_received: 'warning',
  received: 'success',
  closed: 'neutral',
  cancelled: 'danger',
  issued: 'info',
  completed: 'success',
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function statusTone(status: string): StatusTone {
  return STATUS_TONES[status] ?? 'neutral';
}
