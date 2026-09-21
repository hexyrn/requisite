import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomUUID } from 'crypto';
import { Database } from '../db/types';
import { generateSecureToken } from '../security/tokens';

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

export interface SessionRecord {
  id: string;
  organisationId: string;
  userAccountId: string;
  csrfToken: string;
  mfaVerified: boolean;
  expiresAt: Date;
}

/**
 * Server-side session store in Postgres. P0 item 13.
 *
 * Session ID rotation happens on login, MFA completion, and password change
 * (Architecture §6) by always creating a brand-new session row and revoking
 * the old one, rather than mutating a session's id in place - "rotation" is
 * modelled as revoke-old + issue-new, which is simpler to reason about and
 * test than mutating a primary key.
 */
@Injectable()
export class SessionService {
  async createSession(
    db: Kysely<Database>,
    organisationId: string,
    userAccountId: string,
    mfaVerified: boolean,
  ): Promise<SessionRecord> {
    const row = await db
      .insertInto('sessions')
      .values({
        organisation_id: organisationId,
        user_account_id: userAccountId,
        csrf_token: generateSecureToken(24),
        mfa_verified: mfaVerified,
        expires_at: new Date(Date.now() + SESSION_TTL_MS),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.toRecord(row);
  }

  /** Revokes `previousSessionId` (if given) and issues a fresh session - session-fixation defense, Architecture §6. */
  async rotateSession(
    db: Kysely<Database>,
    organisationId: string,
    userAccountId: string,
    mfaVerified: boolean,
    previousSessionId?: string,
  ): Promise<SessionRecord> {
    if (previousSessionId) {
      await this.revokeSession(db, previousSessionId);
    }
    return this.createSession(db, organisationId, userAccountId, mfaVerified);
  }

  async getActiveSession(db: Kysely<Database>, sessionId: string): Promise<SessionRecord | undefined> {
    const row = await db
      .selectFrom('sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    return row ? this.toRecord(row) : undefined;
  }

  async revokeSession(db: Kysely<Database>, sessionId: string): Promise<void> {
    await db
      .updateTable('sessions')
      .set({ revoked_at: new Date() })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Global revocation: "log out everywhere" - password reset or admin action. */
  async revokeAllSessionsForUser(db: Kysely<Database>, userAccountId: string): Promise<void> {
    await db
      .updateTable('sessions')
      .set({ revoked_at: new Date() })
      .where('user_account_id', '=', userAccountId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  private toRecord(row: {
    id: string;
    organisation_id: string;
    user_account_id: string;
    csrf_token: string;
    mfa_verified: boolean;
    expires_at: Date | string;
  }): SessionRecord {
    return {
      id: row.id,
      organisationId: row.organisation_id,
      userAccountId: row.user_account_id,
      csrfToken: row.csrf_token,
      mfaVerified: row.mfa_verified,
      expiresAt: new Date(row.expires_at),
    };
  }
}

export function newCorrelationId(): string {
  return randomUUID();
}
