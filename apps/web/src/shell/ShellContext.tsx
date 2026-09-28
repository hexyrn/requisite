import React from 'react';
import type { LauncherApp } from '../api/client';

export interface ShellState {
  orgName: string | null;
  userEmail: string | null;
  apps: LauncherApp[];
  canAdminister: boolean;
  /** Re-reads the organisation and app list (e.g. after a licence activates an app). */
  refresh?: () => Promise<void>;
}

const ShellContext = React.createContext<ShellState | null>(null);
export const ShellProvider = ShellContext.Provider;

/** What Core knows about the signed-in user's suite: organisation, user, and the apps they can open. */
export function useShell(): ShellState {
  const value = React.useContext(ShellContext);
  if (!value) throw new Error('useShell must be used inside <AuthenticatedShell>.');
  return value;
}

/** "Hexyrn Requisite" -> "Requisite": the top bar already says Hexyrn. */
export function shortAppName(displayName: string): string {
  return displayName.replace(/^Hexyrn\s+/i, '');
}
