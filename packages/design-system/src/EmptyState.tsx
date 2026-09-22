import React from 'react';

/**
 * Intentional empty state (item 18) - a message plus an optional call to
 * action, never an unexplained blank table. Added to Core Design System
 * since every list screen needs this identical shape.
 */
export interface EmptyStateProps {
  message: string;
  action?: React.ReactNode;
}

export function EmptyState({ message, action }: EmptyStateProps) {
  return (
    <div
      role="status"
      style={{
        textAlign: 'center',
        padding: '48px 24px',
        color: '#6b7280',
        background: '#fff',
        border: '1px dashed #d1d5db',
        borderRadius: 8,
      }}
    >
      <p style={{ marginBottom: action ? 16 : 0, fontSize: 14 }}>{message}</p>
      {action}
    </div>
  );
}
