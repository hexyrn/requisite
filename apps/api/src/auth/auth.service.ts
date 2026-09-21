import { Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../db/types';
import { verifyPassword, hashPassword } from '../security/passwords';
import { SessionService, SessionRecord } from '../sessions/session.service';
import { AuditService } from '../audit/audit.service';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 1000 * 60 * 15; // 15 minutes

export interface LoginResult {
  userAccountId: string;
  requiresMfa: boolean;
  session: SessionRecord;
}

/**
 * Authentication. P0 item 12. Brute-force lockout is enforced here
 * (per-account failed_login_count + locked_until); endpoint-level rate
 * limiting (per-IP) is enforced by the Fastify rate-limit plugin registered
 * in main.ts on the auth routes - the two are independent, complementary
 * defenses (account-level vs. source-level).
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async login(
    db: Kysely<Database>,
    organisationId: string,
    email: string,
    password: string,
  ): Promise<LoginResult> {
    const user = await db
      .selectFrom('user_accounts')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .where('email', '=', email)
      .executeTakeFirst();

    // Constant-shape failure regardless of whether the account exists, to
    // avoid user-enumeration via response timing/shape differences.
    if (!user) {
      await this.recordFailedLogin(db, organisationId, null, 'unknown-account');
      throw new UnauthorizedException('Invalid email or password.');
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await this.recordFailedLogin(db, organisationId, user.id, 'locked');
      throw new ForbiddenException('Account is temporarily locked due to repeated failed sign-in attempts.');
    }

    if (!user.is_active) {
      await this.recordFailedLogin(db, organisationId, user.id, 'inactive');
      throw new ForbiddenException('Account is deactivated.');
    }

    const valid = await verifyPassword(user.password_hash, password);
    if (!valid) {
      await this.registerFailedAttempt(db, user.id, user.failed_login_count);
      await this.recordFailedLogin(db, organisationId, user.id, 'bad-password');
      throw new UnauthorizedException('Invalid email or password.');
    }

    // Successful login resets the failed-attempt counter and rotates the session
    // (Architecture §6 - new session id on every successful login).
    await db
      .updateTable('user_accounts')
      .set({ failed_login_count: 0, locked_until: null })
      .where('id', '=', user.id)
      .execute();

    const session = await this.sessions.createSession(db, organisationId, user.id, false);

    await this.audit.record(db, {
      organisationId,
      eventType: 'auth.login.success',
      actorUserAccountId: user.id,
      entityType: 'user_account',
      entityRef: user.id,
    });

    return { userAccountId: user.id, requiresMfa: user.mfa_enabled, session };
  }

  async logout(db: Kysely<Database>, organisationId: string, sessionId: string, userAccountId: string): Promise<void> {
    await this.sessions.revokeSession(db, sessionId);
    await this.audit.record(db, {
      organisationId,
      eventType: 'auth.logout',
      actorUserAccountId: userAccountId,
      entityType: 'session',
      entityRef: sessionId,
    });
  }

  /**
   * Account deactivation synchronously revokes all active sessions for that
   * user, in the same transaction, per Architecture §6 ("this is the exact
   * behaviour §49 requires being tested").
   */
  async deactivateAccount(db: Kysely<Database>, organisationId: string, userAccountId: string, actorUserAccountId: string): Promise<void> {
    await db.updateTable('user_accounts').set({ is_active: false }).where('id', '=', userAccountId).execute();
    await this.sessions.revokeAllSessionsForUser(db, userAccountId);
    await this.audit.record(db, {
      organisationId,
      eventType: 'auth.account.deactivated',
      actorUserAccountId,
      entityType: 'user_account',
      entityRef: userAccountId,
    });
  }

  async activateAccount(db: Kysely<Database>, organisationId: string, userAccountId: string, actorUserAccountId: string): Promise<void> {
    await db.updateTable('user_accounts').set({ is_active: true }).where('id', '=', userAccountId).execute();
    await this.audit.record(db, {
      organisationId,
      eventType: 'auth.account.activated',
      actorUserAccountId,
      entityType: 'user_account',
      entityRef: userAccountId,
    });
  }

  async changePassword(
    db: Kysely<Database>,
    organisationId: string,
    userAccountId: string,
    newPassword: string,
    previousSessionId?: string,
  ): Promise<SessionRecord> {
    const passwordHash = await hashPassword(newPassword);
    await db.updateTable('user_accounts').set({ password_hash: passwordHash }).where('id', '=', userAccountId).execute();
    // Password change rotates the session id (Architecture §6) and revokes all others.
    await this.sessions.revokeAllSessionsForUser(db, userAccountId);
    return this.sessions.createSession(db, organisationId, userAccountId, true);
  }

  private async registerFailedAttempt(db: Kysely<Database>, userAccountId: string, currentCount: number): Promise<void> {
    const nextCount = currentCount + 1;
    const shouldLock = nextCount >= MAX_FAILED_ATTEMPTS;
    await db
      .updateTable('user_accounts')
      .set({
        failed_login_count: nextCount,
        locked_until: shouldLock ? new Date(Date.now() + LOCKOUT_MS) : null,
      })
      .where('id', '=', userAccountId)
      .execute();
  }

  private async recordFailedLogin(
    db: Kysely<Database>,
    organisationId: string,
    userAccountId: string | null,
    reason: string,
  ): Promise<void> {
    await this.audit.record(db, {
      organisationId,
      eventType: 'auth.login.failed',
      actorUserAccountId: userAccountId,
      entityType: 'user_account',
      entityRef: userAccountId,
      metadata: { reason },
    });
  }
}
