import React from 'react';

/**
 * A consistent page/section header - title, optional subtitle/status
 * slot, optional primary action. Added to Core Design System (item 24):
 * every list/detail screen across Core and Requisite needs "title + one
 * obvious primary action," so this belongs as a shared primitive rather
 * than being reimplemented per screen.
 */
export interface PageHeaderProps {
  title: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}

export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: 20,
        gap: 16,
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: '#111827' }}>{title}</h1>
        {subtitle && <div style={{ marginTop: 4, color: '#6b7280', fontSize: 14 }}>{subtitle}</div>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}
