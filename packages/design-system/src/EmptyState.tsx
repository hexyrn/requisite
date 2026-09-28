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
    <div role="status" className="hx-empty">
      <p>{message}</p>
      {action}
    </div>
  );
}
