import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { TabNav, TAB_CLASS } from '@hexyrn/design-system';
import { LicenceGate } from './LicenceGate';

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
    <LicenceGate>
      <div>
        <TabNav aria-label="Requisite navigation">
          {LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end} className={TAB_CLASS}>
              {link.label}
            </NavLink>
          ))}
        </TabNav>
        <Outlet />
      </div>
    </LicenceGate>
  );
}
