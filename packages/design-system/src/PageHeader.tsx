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
    <div className="hx-page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <div className="hx-page-header__subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="hx-page-header__actions">{actions}</div>}
    </div>
  );
}
