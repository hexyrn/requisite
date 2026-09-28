import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { PageHeader, TabNav, TAB_CLASS } from '@hexyrn/design-system';

/**
 * P3 items 9/10/14/19/21/24: the operator-facing admin area gathering
 * the five screens whose HTTP endpoints existed with no frontend
 * (backup, update, support bundle, licence, SMTP) plus system health.
 * Gated implicitly - every underlying API call is ORGANISATION_MANAGE-
 * gated server-side; a non-admin reaching this UI still cannot fetch or
 * mutate anything (the backend is the actual authority, not this nav).
 */
const TABS: Array<{ to: string; label: string }> = [
  { to: '/admin/health', label: 'Health' },
  { to: '/admin/backup', label: 'Backup & Restore' },
  { to: '/admin/update', label: 'Updates' },
  { to: '/admin/licence', label: 'Licence' },
  { to: '/admin/smtp', label: 'SMTP' },
  { to: '/admin/support-bundle', label: 'Support Bundle' },
];

export function AdminLayout() {
  return (
    <div>
      <PageHeader
        title="Administration"
        subtitle="Operator tools: system health, backup/restore, updates, licensing, SMTP, and support bundles."
      />
      <TabNav aria-label="Administration navigation">
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} className={TAB_CLASS}>
            {tab.label}
          </NavLink>
        ))}
      </TabNav>
      <Outlet />
    </div>
  );
}
