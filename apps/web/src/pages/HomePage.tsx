import React from 'react';
import { Link } from 'react-router-dom';
import { AppIcon, EmptyState, PageHeader, StatusBadge, ThemeScope } from '@hexyrn/design-system';
import type { LauncherApp } from '../api/client';
import { shortAppName, useShell } from '../shell/ShellContext';

const STATUS_LABEL: Record<LauncherApp['status'], string> = {
  active: 'Active',
  not_licensed: 'Not licensed',
  disabled: 'Disabled',
  incompatible: 'Needs update',
};

/** Core's home page: the launcher for every app in the suite this user can open. */
export function HomePage() {
  const { apps, canAdminister, orgName } = useShell();

  return (
    <div>
      <PageHeader
        title={orgName ? `Welcome to ${orgName}` : 'Welcome'}
        subtitle="Open an app to get started."
      />

      {apps.length === 0 && !canAdminister ? (
        <EmptyState message="No apps are available to your account yet. Ask your administrator to grant you access." />
      ) : (
        <div className="hx-tiles" aria-label="Apps">
          {apps.map((app) => {
            const active = app.status === 'active';
            const name = shortAppName(app.displayName);
            return (
              <ThemeScope key={app.appId} color={app.brand?.color}>
                <Link
                  to={app.launchPath}
                  className={`hx-tile${active ? '' : ' hx-tile--inactive'}`}
                  aria-label={active ? `Open ${name}` : `${name} - ${STATUS_LABEL[app.status]}`}
                >
                  <AppIcon icon={app.brand?.icon} name={name} size="lg" />
                  <div>
                    <div className="hx-tile__name">{name}</div>
                    {app.description && <p className="hx-tile__desc">{app.description}</p>}
                  </div>
                  <div className="hx-tile__foot">
                    {active ? (
                      <>
                        <span>Open</span>
                        <span aria-hidden="true">→</span>
                      </>
                    ) : (
                      <>
                        <StatusBadge label={STATUS_LABEL[app.status]} tone="warning" />
                        <span>Manage licence →</span>
                      </>
                    )}
                  </div>
                </Link>
              </ThemeScope>
            );
          })}
          {canAdminister && (
            <ThemeScope app="core">
              <Link to="/admin" className="hx-tile" aria-label="Open Administration">
                <AppIcon icon="gear" name="Administration" size="lg" />
                <div>
                  <div className="hx-tile__name">Administration</div>
                  <p className="hx-tile__desc">
                    System health, backup and restore, updates, licences, email and support tools.
                  </p>
                </div>
                <div className="hx-tile__foot">
                  <span>Open</span>
                  <span aria-hidden="true">→</span>
                </div>
              </Link>
            </ThemeScope>
          )}
        </div>
      )}
    </div>
  );
}
