import React from 'react';

/** Class for an individual tab link. React Router's <NavLink className={TAB_CLASS}> adds "active" automatically. */
export const TAB_CLASS = 'hx-tab';

export interface TabNavProps {
  'aria-label': string;
  children: React.ReactNode;
}

/** Horizontal sub-navigation inside an app; scrolls on narrow screens rather than wrapping. */
export function TabNav({ children, ...rest }: TabNavProps) {
  return (
    <nav className="hx-tabs" {...rest}>
      {children}
    </nav>
  );
}
