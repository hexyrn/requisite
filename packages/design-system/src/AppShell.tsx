import React from 'react';

export interface AppShellProps {
  /** Left side of the top bar: usually the brand link plus the current app's name. */
  brand: React.ReactNode;
  /** Small text next to the brand on wide screens (organisation name). */
  orgName?: string;
  /** Right side of the top bar: app switcher, user menu... */
  actions?: React.ReactNode;
  children: React.ReactNode;
}

/** The chrome shared by every screen after sign-in: top bar (accent-striped per app) + centred content column. */
export function AppShell({ brand, orgName, actions, children }: AppShellProps) {
  return (
    <div className="hx-shell">
      <header className="hx-topbar">
        {brand}
        {orgName && <span className="hx-topbar__org">{orgName}</span>}
        <span className="hx-topbar__spacer" />
        {actions}
      </header>
      <main className="hx-main">{children}</main>
    </div>
  );
}
