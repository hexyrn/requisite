import React from 'react';

/**
 * Generic status indicator, added to Core Design System because Requisite
 * needed the same "coloured status pill with a text label" shape for
 * requisitions/POs/goods receipts/quotes, and it's a genuinely reusable
 * primitive (item 24), not domain-specific. Never colour-only (item 23):
 * always renders the label text, and `tone` maps to both colour AND an
 * accessible `data-tone` attribute so status is never conveyed by colour
 * alone.
 */
export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
}

export function StatusBadge({ label, tone = 'neutral' }: StatusBadgeProps) {
  return (
    <span data-tone={tone} className="hx-badge">
      {label}
    </span>
  );
}
