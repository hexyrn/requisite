import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Pool } from 'pg';
import { getPool } from '../../db/pool';
import { Database } from '../../db/types';
import { withNoOrgContext, withOrgContext } from '../../db/org-context';
import { generateSecureToken, hashToken, verifyTokenHash } from '../../security/tokens';
import { PermissionCheckSubject } from '../../rbac/permission-evaluator';

const KEY_PREFIX_PREFIX = 'hxk_'; // public "Hexyrn key" marker, not secret

export interface IssuedCredential {
  credentialId: string;
  /** The full plaintext API key - shown to the caller exactly once, never stored. */
  plaintextKey: string;
  keyPrefix: string;
}

/**
 * Service Accounts + API Credentials + API Scopes. P2 items 12/13. Scopes
 * are deliberately just permission-key strings reused from the SAME flat
 * permission model every other subsystem checks against
 * (FlatRolePermissionEvaluator) - "no second authorisation universe" per
 * item 13's explicit requirement. A service account's grantedPermissions
 * for a PermissionCheckSubject are exactly its granted_scopes.
 */
@Injectable()
export class ServiceAccountService {
  async createServiceAccount(db: Kysely<Database>, organisationId: string, name: string, scopes: string[], createdBy?: string) {
    return db
      .insertInto('service_accounts')
      .values({ organisation_id: organisationId, name, granted_scopes: scopes, created_by: createdBy ?? null })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Issues a new API credential. The plaintext key is `hxk_<prefix>.<secret>`
   * - only `key_prefix` and a hash of the secret are ever persisted in
   * `api_credentials` (RLS-protected, org-scoped). The PUBLIC prefix is also
   * written to `api_credential_lookup` (no RLS, no secret material) purely
   * so authentication can discover which organisation to open a context for
   * BEFORE the secret has been verified - see migration 0032's comment for
   * why this mirrors ADR 0005's dispatch_queue pattern.
   */
  async issueCredential(db: Kysely<Database>, organisationId: string, serviceAccountId: string, pool: Pool = getPool()): Promise<IssuedCredential> {
    const prefix = generateSecureToken(6); // short, public, display-only identifier
    const secret = generateSecureToken(32); // high-entropy, never stored in plaintext
    const plaintextKey = `${KEY_PREFIX_PREFIX}${prefix}.${secret}`;

    const credential = await db
      .insertInto('api_credentials')
      .values({ organisation_id: organisationId, service_account_id: serviceAccountId, key_prefix: prefix, secret_hash: hashToken(secret) })
      .returningAll()
      .executeTakeFirstOrThrow();

    // Written under withNoOrgContext deliberately - api_credential_lookup has
    // no RLS (see migration 0032), so this INSERT does not depend on / is
    // not filtered by app.current_organisation_id.
    await withNoOrgContext(
      (noOrgDb) =>
        noOrgDb
          .insertInto('api_credential_lookup')
          .values({ key_prefix: prefix, organisation_id: organisationId, credential_id: credential.id, service_account_id: serviceAccountId })
          .execute(),
      pool,
    );

    return { credentialId: credential.id, plaintextKey, keyPrefix: prefix };
  }

  async revokeCredential(db: Kysely<Database>, organisationId: string, credentialId: string, pool: Pool = getPool()): Promise<void> {
    const row = await db
      .updateTable('api_credentials')
      .set({ is_revoked: true, revoked_at: new Date() as any })
      .where('id', '=', credentialId)
      .where('organisation_id', '=', organisationId)
      .returningAll()
      .executeTakeFirst();
    if (row) {
      await withNoOrgContext((noOrgDb) => noOrgDb.deleteFrom('api_credential_lookup').where('credential_id', '=', credentialId).execute(), pool);
    }
  }

  /**
   * Authenticates a presented API key end-to-end. SECURITY-CRITICAL path:
   *   1. Parse the key into prefix/secret; malformed keys are rejected
   *      before touching the database.
   *   2. Resolve organisation_id from the NO-RLS lookup table by prefix
   *      alone - this step reveals only "which org a valid-looking prefix
   *      belongs to," never any secret material, and an unknown prefix
   *      fails closed with no rows.
   *   3. Re-verify the FULL credential (hash comparison, is_revoked,
   *      is_enabled) INSIDE that organisation's real withOrgContext, so the
   *      actual secret/enabled/revoked checks are still subject to RLS -
   *      the lookup table is only ever a routing hint, never itself trusted
   *      as proof of a valid credential.
   */
  async authenticate(plaintextKey: string, pool: Pool = getPool()): Promise<{ organisationId: string; serviceAccountId: string; scopes: string[]; credentialId: string } | null> {
    if (!plaintextKey.startsWith(KEY_PREFIX_PREFIX)) return null;
    const withoutMarker = plaintextKey.slice(KEY_PREFIX_PREFIX.length);
    const dot = withoutMarker.indexOf('.');
    if (dot <= 0) return null;
    const prefix = withoutMarker.slice(0, dot);
    const secret = withoutMarker.slice(dot + 1);
    if (!secret) return null;

    const pointer = await withNoOrgContext((db) => db.selectFrom('api_credential_lookup').selectAll().where('key_prefix', '=', prefix).executeTakeFirst(), pool);
    if (!pointer) return null;

    return this.verifyWithinOrg(pointer.organisation_id, pointer.credential_id, secret, pool);
  }

  private async verifyWithinOrg(organisationId: string, credentialId: string, secret: string, pool: Pool) {
    return withOrgContext(organisationId, async (db) => {
      const credential = await db.selectFrom('api_credentials').selectAll().where('id', '=', credentialId).executeTakeFirst();
      if (!credential || credential.is_revoked) return null;
      if (!verifyTokenHash(secret, credential.secret_hash)) return null;

      const serviceAccount = await db.selectFrom('service_accounts').selectAll().where('id', '=', credential.service_account_id).executeTakeFirst();
      if (!serviceAccount || !serviceAccount.is_enabled) return null;

      await db.updateTable('api_credentials').set({ last_used_at: new Date() as any }).where('id', '=', credentialId).execute();
      await db.updateTable('service_accounts').set({ last_used_at: new Date() as any }).where('id', '=', serviceAccount.id).execute();

      return { organisationId, serviceAccountId: serviceAccount.id, scopes: serviceAccount.granted_scopes, credentialId };
    }, pool);
  }

  /** Builds a PermissionCheckSubject for a service account, for reuse with the exact same FlatRolePermissionEvaluator as human users. */
  toPermissionSubject(auth: { organisationId: string; serviceAccountId: string; scopes: string[] }): PermissionCheckSubject {
    return { userAccountId: auth.serviceAccountId, organisationId: auth.organisationId, grantedPermissions: new Set(auth.scopes) };
  }

  /** Enforces that every scope being granted to a service account is itself held (directly or transitively) - mirrors the P1 "cannot hand out a key you don't hold" invitation rule, item 13. */
  assertGrantableScopes(granterPermissions: ReadonlySet<string>, requestedScopes: string[]): void {
    const missing = requestedScopes.filter((s) => !granterPermissions.has(s));
    if (missing.length > 0) {
      throw new ForbiddenException(`Cannot grant scope(s) you do not hold: ${missing.join(', ')}`);
    }
  }
}

export class ApiKeyAuthenticationError extends UnauthorizedException {}
