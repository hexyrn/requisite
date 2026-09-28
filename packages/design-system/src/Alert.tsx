import React from 'react';

export type AlertTone = 'error' | 'info' | 'success' | 'warning';

export interface AlertProps {
  tone?: AlertTone;
  children: React.ReactNode;
}

/** Inline message. Errors use role="alert" so screen readers announce them; the rest use role="status". */
export function Alert({ tone = 'error', children }: AlertProps) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`hx-alert hx-alert--${tone}`}>
      <div>{children}</div>
    </div>
  );
}
