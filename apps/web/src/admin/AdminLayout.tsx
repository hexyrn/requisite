import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';

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

const tabStyle = (isActive: boolean): React.CSSProperties => ({
  padding: '8px 14px',
  borderRadius: 6,
  textDecoration: 'none',
  color: isActive ? '#fff' : '#1f2933',
  background: isActive ? '#1f2933' : 'transparent',
  fontSize: 14,
  fontWeight: 500,
});

export function AdminLayout() {
  return (
    <div>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Administration</h1>
      <p style={{ color: '#616e7c', marginBottom: 16 }}>
        Operator tools: system health, backup/restore, updates, licensing, SMTP, and support bundles.
      </p>
      <nav style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to} style={({ isActive }) => tabStyle(isActive)}>
            {tab.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
