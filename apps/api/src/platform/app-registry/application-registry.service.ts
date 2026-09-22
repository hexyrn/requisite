import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { PostgresDialect } from 'kysely';
import { Database } from '../../db/types';
import { getPool } from '../../db/pool';
import { HexyrnAppManifest } from '@hexyrn/app-sdk';
import { isCoreVersionCompatible } from '../core-version';

export interface ApplicationState {
  appId: string;
  installed: boolean;
  enabled: boolean;
  licensed: boolean;
  compatible: boolean;
  /** enabled && licensed && compatible - the single "may this app's code actually run" gate. Architecture §3. */
  active: boolean;
}

/**
 * Application Registry. Architecture §3, P1 item 1. `installed_applications`
 * has no RLS (installation-level, like `installations` itself) - registering
 * an app's manifest is a deploy-time/boot-time action, not something any
 * organisation "does." Every other state (enabled, licensed) is per-org and
 * RLS-protected, so this service always requires the caller to already be
 * inside a withOrgContext transaction for anything but `registerApp`.
 */
@Injectable()
export class ApplicationRegistryService {
  /**
   * Registers (or updates) an app's manifest at the installation level.
   * Called at boot for every compiled-in app (Architecture §3 v1 packaging:
   * "monorepo workspace packages, compiled into one build"). Idempotent.
   */
  async registerApp(manifest: HexyrnAppManifest, pool: Pool = getPool()): Promise<void> {
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    await db
      .insertInto('installed_applications')
      .values({
        app_id: manifest.appId,
        display_name: manifest.displayName,
        version: manifest.version,
        major_version: manifest.majorVersion,
        requires_core_version: manifest.requiresCoreVersion,
        description: manifest.description ?? null,
        manifest: manifest as any,
      })
      .onConflict((oc) =>
        oc.column('app_id').doUpdateSet({
          display_name: manifest.displayName,
          version: manifest.version,
          major_version: manifest.majorVersion,
          requires_core_version: manifest.requiresCoreVersion,
          description: manifest.description ?? null,
          manifest: manifest as any,
          updated_at: new Date(),
        }),
      )
      .execute();

    if (manifest.capabilities) {
      for (const cap of manifest.capabilities) {
        if (!cap.provides) continue;
        await db
          .insertInto('capability_providers')
          .values({ capability: cap.capability, app_id: manifest.appId, service_ref: cap.provides.serviceRef })
          .onConflict((oc) => oc.columns(['capability', 'app_id']).doUpdateSet({ service_ref: cap.provides!.serviceRef }))
          .execute();
      }
    }

    if (manifest.eventsConsumed) {
      for (const ec of manifest.eventsConsumed) {
        await db
          .insertInto('event_consumer_registrations')
          .values({ event_type: ec.eventType, consumer_app_id: manifest.appId, handler_ref: ec.handlerRef })
          .onConflict((oc) => oc.columns(['event_type', 'consumer_app_id', 'handler_ref']).doNothing())
          .execute();
      }
    }
  }

  /** Enables an app for an organisation. Runs inside the caller's withOrgContext transaction. */
  async enableApp(db: Kysely<Database>, organisationId: string, appId: string): Promise<void> {
    await db
      .insertInto('app_enablements')
      .values({ organisation_id: organisationId, app_id: appId, enabled: true, enabled_at: new Date() })
      .onConflict((oc) => oc.columns(['organisation_id', 'app_id']).doUpdateSet({ enabled: true, enabled_at: new Date(), disabled_at: null }))
      .execute();
  }

  /**
   * Disables an app for an organisation. Per Architecture §3: "an
   * installed-but-disabled app is inert but its data/migrations remain
   * intact" - this never deletes anything, only flips the flag.
   */
  async disableApp(db: Kysely<Database>, organisationId: string, appId: string): Promise<void> {
    await db
      .updateTable('app_enablements')
      .set({ enabled: false, disabled_at: new Date() })
      .where('organisation_id', '=', organisationId)
      .where('app_id', '=', appId)
      .execute();
  }

  async grantLicense(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
    licensedMajorVersion: number,
    licensePayload: Record<string, unknown>,
  ): Promise<void> {
    // SIMPLIFIED verification for P1 - see docs/decisions/0004-app-licensing-simplification.md.
    // Real asymmetric-signature verification is not implemented; this only
    // checks the payload has the expected shape before recording it as
    // "signature_valid_at = now()".
    if (!licensePayload || typeof licensePayload !== 'object') {
      throw new Error('Invalid license payload');
    }
    await db
      .insertInto('application_licenses')
      .values({
        organisation_id: organisationId,
        app_id: appId,
        licensed_major_version: licensedMajorVersion,
        license_payload: licensePayload as any,
        signature_valid_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(['organisation_id', 'app_id', 'licensed_major_version']).doUpdateSet({
          license_payload: licensePayload as any,
          signature_valid_at: new Date(),
        }),
      )
      .execute();
  }

  /**
   * The single source of truth for "is this app's code allowed to run for
   * this organisation right now" - Architecture §3's inactivity invariant.
   * Every gate (ApplicationActiveGuard, the event dispatcher, the job
   * runner) calls this rather than re-deriving the logic.
   */
  async getApplicationState(db: Kysely<Database>, organisationId: string, appId: string): Promise<ApplicationState> {
    const installedRow = await db.selectFrom('installed_applications').selectAll().where('app_id', '=', appId).executeTakeFirst();
    const installed = !!installedRow;

    const enablementRow = await db
      .selectFrom('app_enablements')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where('app_id', '=', appId)
      .executeTakeFirst();
    const enabled = !!enablementRow?.enabled;

    const licenseRow = await db
      .selectFrom('application_licenses')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where('app_id', '=', appId)
      .executeTakeFirst();
    const licensed = !!licenseRow;

    const compatible = installed ? isCoreVersionCompatible(installedRow!.requires_core_version) : false;

    return {
      appId,
      installed,
      enabled,
      licensed,
      compatible,
      active: installed && enabled && licensed && compatible,
    };
  }

  async listInstalledApps(db: Kysely<Database>) {
    return db.selectFrom('installed_applications').selectAll().execute();
  }
}
