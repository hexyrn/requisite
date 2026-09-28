import React from 'react';
import { Link } from 'react-router-dom';
import { AppIcon, Popover, ThemeScope } from '@hexyrn/design-system';
import { shortAppName, useShell } from './ShellContext';

const GRID_ICON = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="5" cy="5" r="2" />
    <circle cx="12" cy="5" r="2" />
    <circle cx="19" cy="5" r="2" />
    <circle cx="5" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="19" cy="12" r="2" />
    <circle cx="5" cy="19" r="2" />
    <circle cx="12" cy="19" r="2" />
    <circle cx="19" cy="19" r="2" />
  </svg>
);

/** Jump between the suite's apps from anywhere; Core (home) and Administration are always part of the list. */
export function AppSwitcher({ currentBasePath }: { currentBasePath: string | null }) {
  const { apps, canAdminister } = useShell();
  const usable = apps.filter((a) => a.status === 'active');
  return (
    <Popover label="Switch app" trigger={GRID_ICON}>
      <div className="hx-menu-label">Hexyrn suite</div>
      <ThemeScope app="core">
        <Link
          to="/"
          className="hx-menu-item"
          aria-current={currentBasePath === null ? 'page' : undefined}
        >
          <AppIcon icon="home" name="Home" />
          <span className="hx-menu-item__text">
            <span className="hx-menu-item__name">Home</span>
            <span className="hx-menu-item__desc">All your apps</span>
          </span>
        </Link>
      </ThemeScope>
      {usable.map((app) => (
        <ThemeScope key={app.appId} color={app.brand?.color}>
          <Link
            to={app.launchPath}
            className="hx-menu-item"
            aria-current={currentBasePath === app.basePath ? 'page' : undefined}
          >
            <AppIcon icon={app.brand?.icon} name={shortAppName(app.displayName)} />
            <span className="hx-menu-item__text">
              <span className="hx-menu-item__name">{shortAppName(app.displayName)}</span>
              {app.description && <span className="hx-menu-item__desc">{app.description}</span>}
            </span>
          </Link>
        </ThemeScope>
      ))}
      {canAdminister && (
        <>
          <div className="hx-menu-sep" />
          <ThemeScope app="core">
            <Link
              to="/admin"
              className="hx-menu-item"
              aria-current={currentBasePath === '/admin' ? 'page' : undefined}
            >
              <AppIcon icon="gear" name="Administration" />
              <span className="hx-menu-item__text">
                <span className="hx-menu-item__name">Administration</span>
                <span className="hx-menu-item__desc">Health, backups, updates, licences</span>
              </span>
            </Link>
          </ThemeScope>
        </>
      )}
    </Popover>
  );
}
