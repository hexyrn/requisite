import React, { useEffect, useState } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { AppShell, Button, ThemeScope, Alert } from '@hexyrn/design-system';
import { api, ApiError, setCsrfToken, type LauncherApp } from '../api/client';
import { AppSwitcher } from '../shell/AppSwitcher';
import { ShellProvider, shortAppName, type ShellState } from '../shell/ShellContext';

interface OrgSummary {
  display_name: string;
}

/**
 * Core's host shell for the whole suite. Confirms the session (and restores
 * the in-memory CSRF token after a reload), loads the organisation and the
 * apps this user may open, then renders the top bar - themed with the accent
 * of whichever app the current URL belongs to - around the routed page.
 * Business apps register their routes beneath this shell via <Outlet/>.
 */
export function AuthenticatedShell() {
  const [state, setState] = useState<ShellState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // The CSRF token lives only in memory, so after a refresh / new tab it
        // must be re-fetched before any state-changing request can succeed.
        const session = await api.getSession();
        if (cancelled) return;
        setCsrfToken(session.csrfToken);
        const [org, launcher] = await Promise.all([api.getOrganisation(), api.getLauncher()]);
        if (cancelled) return;
        setState({
          orgName: (org as OrgSummary).display_name ?? null,
          userEmail: session.user.email,
          apps: launcher.apps,
          canAdminister: launcher.canAdminister,
        });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          navigate('/login', { replace: true });
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load your workspace.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function onLogout() {
    await api.logout().catch(() => undefined);
    window.location.href = '/login';
  }

  const currentApp: LauncherApp | undefined = state?.apps.find(
    (a) => a.basePath && (pathname === a.basePath || pathname.startsWith(`${a.basePath}/`)),
  );
  const inAdmin = pathname === '/admin' || pathname.startsWith('/admin/');
  const currentBasePath = currentApp?.basePath ?? (inAdmin ? '/admin' : null);
  const sectionName = currentApp
    ? shortAppName(currentApp.displayName)
    : inAdmin
      ? 'Administration'
      : null;

  const shell = (
    <ThemeScope app={currentApp ? undefined : 'core'} color={currentApp?.brand?.color}>
      <AppShell
        orgName={state?.orgName ?? undefined}
        brand={
          <Link to="/" className="hx-brand" aria-label="Hexyrn home">
            <span className="hx-brand__mark" aria-hidden="true">
              H
            </span>
            <span className={sectionName ? 'hx-brand__hide-sm' : undefined}>Hexyrn</span>
            {sectionName && (
              <>
                <span className="hx-brand__sep hx-brand__hide-sm" aria-hidden="true">
                  /
                </span>
                <span className="hx-brand__app">{sectionName}</span>
              </>
            )}
          </Link>
        }
        actions={
          state && (
            <>
              <AppSwitcher currentBasePath={currentBasePath} />
              <span className="hx-muted hx-topbar__org" title="Signed in as">
                {state.userEmail}
              </span>
              <Button variant="ghost" onClick={onLogout}>
                Log out
              </Button>
            </>
          )
        }
      >
        {error && <Alert>{error}</Alert>}
        {state ? (
          <Outlet />
        ) : (
          !error && (
            <p className="hx-muted" role="status">
              Loading…
            </p>
          )
        )}
      </AppShell>
    </ThemeScope>
  );

  // The provider wraps the WHOLE shell: the top bar's app switcher needs it too, not just the routed page.
  return state ? <ShellProvider value={state}>{shell}</ShellProvider> : shell;
}
