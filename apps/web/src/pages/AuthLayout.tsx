import React from 'react';
import { Card, ThemeScope } from '@hexyrn/design-system';

export interface AuthLayoutProps {
  title: string;
  subtitle?: React.ReactNode;
  /** Card width in px (setup wizard is wider than sign-in). */
  width?: number;
  children: React.ReactNode;
}

/** Centred, branded card used by every signed-out screen (sign in, MFA, first-run setup). */
export function AuthLayout({ title, subtitle, width = 400, children }: AuthLayoutProps) {
  return (
    <ThemeScope app="core">
      <div className="hx-auth">
        <div className="hx-auth__card" style={{ maxWidth: width }}>
          <div className="hx-auth__brand">
            <span className="hx-brand__mark" aria-hidden="true">
              H
            </span>
            <strong>Hexyrn</strong>
          </div>
          <Card>
            <h1>{title}</h1>
            {subtitle && <p className="hx-muted">{subtitle}</p>}
            {children}
          </Card>
        </div>
      </div>
    </ThemeScope>
  );
}
