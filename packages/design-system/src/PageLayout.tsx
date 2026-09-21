import React from 'react';

export interface PageLayoutProps {
  title: string;
  orgName?: string;
  nav?: React.ReactNode;
  children: React.ReactNode;
}

export function PageLayout({ title, orgName, nav, children }: PageLayoutProps) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 24px',
          background: '#1f4b99',
          color: '#fff',
        }}
      >
        <strong>Hexyrn{orgName ? ` — ${orgName}` : ''}</strong>
        <nav>{nav}</nav>
      </header>
      <main style={{ flex: 1, padding: 24, background: '#f7f7f9' }}>
        <h1 style={{ fontSize: 20, marginBottom: 16 }}>{title}</h1>
        {children}
      </main>
    </div>
  );
}
