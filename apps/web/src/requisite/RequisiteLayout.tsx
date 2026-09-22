import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';

/** Requisite's own sub-navigation (item 4): Home, Requisitions, Purchase Orders, Goods Receipts, Suppliers, Quotes/RFQs, Reports. */
const LINKS: Array<{ to: string; label: string; end?: boolean }> = [
  { to: '/requisite', label: 'Home', end: true },
  { to: '/requisite/requisitions', label: 'Requisitions' },
  { to: '/requisite/purchase-orders', label: 'Purchase Orders' },
  { to: '/requisite/goods-receipts', label: 'Goods Receipts' },
  { to: '/requisite/suppliers', label: 'Suppliers' },
  { to: '/requisite/rfqs', label: 'Quotes/RFQs' },
  { to: '/requisite/reports', label: 'Reports' },
];

export function RequisiteLayout() {
  return (
    <div>
      <nav aria-label="Requisite navigation" style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #e5e7eb', paddingBottom: 8 }}>
        {LINKS.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            style={({ isActive }) => ({
              padding: '6px 12px',
              borderRadius: 6,
              fontSize: 14,
              textDecoration: 'none',
              color: isActive ? '#1f4b99' : '#4b5563',
              background: isActive ? '#eef2ff' : 'transparent',
              fontWeight: isActive ? 600 : 400,
            })}
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
