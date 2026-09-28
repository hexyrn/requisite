import { Injectable } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { HexyrnAppManifest } from '@hexyrn/app-sdk';
import type { Database } from '../../db/types';
import { CORE_PERMISSIONS } from '../../rbac/permissions';
import { ApplicationRegistryService } from './application-registry.service';

export type LauncherStatus = 'active' | 'not_licensed' | 'disabled' | 'incompatible';

export interface LauncherApp {
  appId: string;
  displayName: string;
  description: string | null;
  version: string;
  brand: { color: string; icon: string | null } | null;
  /** Where the tile should take the user: the app's first page they may see, or the licence screen for admins on an inactive app. */
  launchPath: string;
  /** First URL segment the app owns (e.g. '/requisite'); lets the shell tell which app the current page belongs to. */
  basePath: string | null;
  status: LauncherStatus;
}

export interface LauncherResponse {
  apps: LauncherApp[];
  canAdminister: boolean;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The suite launcher: what the Core home page and app switcher show.
 *
 * Deliberately conservative about disclosure (Architecture §3 - an app the
 * caller may not use must be indistinguishable from an app that is not
 * installed): ordinary users only ever see apps that are installed, enabled,
 * licensed and compatible AND expose at least one page they hold permission
 * for. Only organisation administrators (who already see licence status in
 * the admin area) additionally see apps that are installed but inactive, so
 * they can tell "Requisite is not licensed" from "Requisite is missing".
 */
@Injectable()
export class LauncherService {
  constructor(private readonly registry: ApplicationRegistryService) {}

  async build(
    db: Kysely<Database>,
    organisationId: string,
    granted: ReadonlySet<string>,
  ): Promise<LauncherResponse> {
    const canAdminister = granted.has(CORE_PERMISSIONS.ORGANISATION_MANAGE);
    const installed = await this.registry.listInstalledApps(db);
    const apps: LauncherApp[] = [];

    for (const row of installed) {
      const manifest = row.manifest as unknown as HexyrnAppManifest;
      if (manifest?.internal) continue;

      const state = await this.registry.getApplicationState(db, organisationId, row.app_id);
      const status = statusOf(state);

      const visibleNav = (manifest?.navigation ?? [])
        .filter((n) => !n.permission || granted.has(n.permission))
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

      let launchPath: string;
      if (status === 'active') {
        if (visibleNav.length === 0) continue; // active, but nothing here this user may open
        launchPath = visibleNav[0].path;
      } else {
        if (!canAdminister) continue;
        launchPath = '/admin/licence';
      }

      const color = manifest?.brand?.color;
      apps.push({
        appId: row.app_id,
        displayName: row.display_name,
        description: row.description,
        version: row.version,
        brand:
          color && HEX_COLOR.test(color)
            ? { color: color.toLowerCase(), icon: manifest.brand?.icon ?? null }
            : null,
        launchPath,
        basePath: basePathOf(manifest),
        status,
      });
    }

    apps.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return { apps, canAdminister };
  }
}

function statusOf(state: {
  installed: boolean;
  enabled: boolean;
  licensed: boolean;
  compatible: boolean;
  active: boolean;
}): LauncherStatus {
  if (state.active) return 'active';
  if (!state.compatible) return 'incompatible';
  if (!state.enabled) return 'disabled';
  return 'not_licensed';
}

function basePathOf(manifest: HexyrnAppManifest | undefined): string | null {
  const first = manifest?.navigation?.[0]?.path;
  const segment = first?.split('/').filter(Boolean)[0];
  return segment ? `/${segment}` : null;
}
