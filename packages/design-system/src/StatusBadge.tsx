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

const TONE_COLORS: Record<StatusTone, { bg: string; fg: string }> = {
  neutral: { bg: '#e5e7eb', fg: '#374151' },
  info: { bg: '#dbeafe', fg: '#1e40af' },
  success: { bg: '#dcfce7', fg: '#166534' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
  danger: { bg: '#fee2e2', fg: '#991b1b' },
};

export interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
}

export function StatusBadge({ label, tone = 'neutral' }: StatusBadgeProps) {
  const colors = TONE_COLORS[tone];
  return (
    <span
      data-tone={tone}
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: colors.bg,
        color: colors.fg,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}
