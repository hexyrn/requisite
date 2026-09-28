import { Body, Controller, NotFoundException, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { TotpService } from './totp.service';
import { InstallationRepository } from '../bootstrap/installation.repository';
import { withOrgContext } from '../db/org-context';
import { AllowPreMfa, PublicRoute } from '../http/session-auth.guard';
import { AuthenticatedOnly, RequirePermission } from '../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../rbac/permissions';
import {
  encodeSessionCookie,
  decodeSessionCookie,
  SESSION_COOKIE_NAME,
} from '../http/session-cookie';
import { SessionService } from '../sessions/session.service';
import { UnauthorizedException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import {
  enforceRateLimit,
  loginRateLimiters,
  mfaVerifyRateLimiters,
} from '../security/rate-limits';
import { LoginDto, MfaVerifyDto, MfaEnrollConfirmDto } from './dto';

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE !== 'false',
    sameSite: 'lax' as const,
    path: '/',
  };
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly totp: TotpService,
    private readonly installations: InstallationRepository,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  @PublicRoute()
  @Post('login')
  async login(
    @Req() req: FastifyRequest,
    @Body() body: LoginDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    // Rate limiting BEFORE any DB work - both dimensions (Architecture-
    // required: account-based on top of AuthService's own lockout, and
    // IP/source-based respecting the configured trusted-proxy list via
    // Fastify's own `request.ip`, set up in main.ts).
    enforceRateLimit(loginRateLimiters, body.email, req.ip);

    const organisationId = await this.installations.getPrimaryOrganisationId();
    const outcome = await withOrgContext(organisationId, (db) =>
      this.auth.login(db, organisationId, body.email, body.password),
    );

    // The failure-bookkeeping (lockout counter, audit event) has already
    // been committed by AuthService.login regardless of outcome - see the
    // comment on that method. Only NOW do we decide what to tell the caller.
    if (!outcome.ok) {
      if (outcome.reason === 'locked') {
        throw new ForbiddenException(
          'Account is temporarily locked due to repeated failed sign-in attempts.',
        );
      }
      if (outcome.reason === 'inactive') {
        throw new ForbiddenException('Account is deactivated.');
      }
      // 'unknown-account' and 'bad-password' get the same message/shape -
      // no user-enumeration via response differences.
      throw new UnauthorizedException('Invalid email or password.');
    }

    res.setCookie(
      SESSION_COOKIE_NAME,
      encodeSessionCookie(organisationId, outcome.session.id),
      cookieOptions(),
    );

    return {
      requiresMfa: outcome.requiresMfa,
      csrfToken: outcome.session.csrfToken,
    };
  }

  /**
   * Completes the login flow for an account with MFA enabled. Verifies the
   * TOTP code against the pending (mfa_verified=false) session's user, then
   * rotates the session per Architecture §6 ("new session id on ... MFA
   * completion") - the pre-MFA session is revoked and a fresh, mfa_verified
   * session is issued and re-cookied.
   */
  @PublicRoute()
  @Post('mfa/verify')
  async verifyMfa(
    @Req() req: FastifyRequest,
    @Body() body: MfaVerifyDto,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const organisationId = await this.installations.getPrimaryOrganisationId();
    const decoded = decodeSessionCookie((req as any).cookies?.[SESSION_COOKIE_NAME]);
    if (!decoded) {
      throw new UnauthorizedException('No pending session.');
    }

    // Keyed by the pending session id (a stand-in for "this login attempt")
    // rather than a user id, since we haven't loaded the user yet and don't
    // want to do DB work before rate-limit-checking an unauthenticated caller.
    enforceRateLimit(mfaVerifyRateLimiters, decoded.sessionId, req.ip);

    const newSession = await withOrgContext(organisationId, async (db) => {
      const pending = await this.sessions.getActiveSession(db, decoded.sessionId);
      if (!pending) throw new UnauthorizedException('Session is invalid, expired, or revoked.');

      let usedRecoveryCode = false;
      let valid = await this.totp.verifyChallenge(db, pending.userAccountId, body.code);
      if (!valid) {
        // Fall back to a one-time recovery code (Architecture §6 MFA recovery).
        valid = await this.totp.consumeRecoveryCode(db, pending.userAccountId, body.code);
        usedRecoveryCode = valid;
      }
      if (!valid) throw new BadRequestException('Invalid MFA code.');

      if (usedRecoveryCode) {
        await this.audit.record(db, {
          organisationId,
          eventType: 'auth.mfa.recovery_code_used',
          actorUserAccountId: pending.userAccountId,
          entityType: 'user_account',
          entityRef: pending.userAccountId,
        });
      }

      return this.sessions.rotateSession(
        db,
        organisationId,
        pending.userAccountId,
        true,
        pending.id,
      );
    });

    res.setCookie(
      SESSION_COOKIE_NAME,
      encodeSessionCookie(organisationId, newSession.id),
      cookieOptions(),
    );
    return { verified: true, csrfToken: newSession.csrfToken };
  }

  /**
   * Full MFA enrolment flow, P0 item 16 (RFC 6238 TOTP + recovery codes).
   *
   * Step 1 (begin): generates a fresh secret and otpauth:// URL for the
   * currently authenticated user. Deliberately NOT persisted anywhere yet -
   * nothing is written to the database until proof-of-possession (step 2)
   * succeeds, so an abandoned enrolment attempt leaves no half-enabled MFA
   * state. The secret is returned to the client exactly once, to be
   * displayed as a QR code / manual-entry string; the client must echo it
   * back (together with a valid code) to complete enrolment - after that,
   * only the encrypted-at-rest copy exists, and it is never re-exposed in
   * plaintext by any endpoint again.
   */
  @AuthenticatedOnly()
  @Post('mfa/enroll/begin')
  async beginMfaEnrolment(@Req() req: FastifyRequest) {
    const user = (req as any).currentUser;
    const { secret, otpauthUrl } = this.totp.beginEnrolment(user.email);
    return { secret, otpauthUrl };
  }

  /**
   * Step 2 (confirm): requires proof-of-possession (a currently valid TOTP
   * code generated from the secret returned in step 1) before anything is
   * persisted. Only on success: encrypts and stores the secret, flips
   * mfa_enabled, generates one-time recovery codes (hashed at rest,
   * returned in plaintext exactly once here), and records an audit event.
   */
  @AuthenticatedOnly()
  @Post('mfa/enroll/confirm')
  async confirmMfaEnrolment(@Req() req: FastifyRequest, @Body() body: MfaEnrollConfirmDto) {
    const organisationId = (req as any).currentOrganisationId;
    const user = (req as any).currentUser;

    const session = (req as any).currentSession;
    const recoveryCodes = await withOrgContext(organisationId, async (db) => {
      const codes = await this.totp.completeEnrolment(
        db,
        user.id,
        body.secret,
        body.code,
        organisationId,
      );
      // The user just proved possession of the new second factor in this very
      // request, so the session that enrolled it counts as MFA-verified -
      // otherwise the guard (which now requires it once mfa_enabled) would
      // lock them out of their own session the moment enrolment succeeds.
      await this.sessions.markMfaVerified(db, session.id);
      await this.audit.record(db, {
        organisationId,
        eventType: 'auth.mfa.enrolled',
        actorUserAccountId: user.id,
        entityType: 'user_account',
        entityRef: user.id,
      });
      return codes;
    });

    return { enabled: true, recoveryCodes };
  }

  /**
   * Administrator-assisted MFA reset (Architecture §6 / P3 item 33): the
   * lost-device-and-recovery-codes case, distinct from self-service login
   * (which never bypasses MFA). Deliberately gated by USERS_MFA_RESET, a
   * SEPARATE elevated permission from USERS_MANAGE (see permissions.ts) -
   * being able to edit a user's profile/role does not imply being able to
   * strip their second factor. Always audited (this is exactly the kind of
   * sensitive, rare admin action Architecture §6 says "doing so is itself
   * an audited, permission-gated action so it can't be used quietly").
   *
   * Also revokes every active session for the target user: if an account
   * is in a state where an admin needs to intervene on its MFA, any
   * existing session should not be trusted to continue unchallenged -
   * matches the existing revoke-on-deactivation/revoke-on-password-reset
   * pattern (session.service.ts).
   *
   * An admin cannot reset their OWN MFA through this endpoint - the
   * self-service path (re-enrol, or use a recovery code) is enough for the
   * admin's own account, and this closes off a trivial self-serve MFA
   * bypass by anyone holding USERS_MFA_RESET on their own account (they
   * would still need this permission specifically to try it, but requiring
   * a distinct admin to act removes any ambiguity, matching the same
   * "genuinely distinct approver" pattern already enforced for Requisite
   * approvals).
   */
  @RequirePermission(CORE_PERMISSIONS.USERS_MFA_RESET)
  @Post('users/:id/mfa/reset')
  async adminResetMfa(@Req() req: FastifyRequest, @Param('id') targetUserId: string) {
    const organisationId = (req as any).currentOrganisationId;
    const actor = (req as any).currentUser;

    if (targetUserId === actor.id) {
      throw new BadRequestException(
        'You cannot reset your own MFA through this endpoint - re-enrol or use a recovery code, or have another administrator perform this action.',
      );
    }

    await withOrgContext(organisationId, async (db) => {
      const target = await db
        .selectFrom('user_accounts')
        .select(['id'])
        .where('id', '=', targetUserId)
        .executeTakeFirst();
      if (!target) throw new NotFoundException('User not found.');

      await this.totp.adminResetMfa(db, targetUserId);
      await this.sessions.revokeAllSessionsForUser(db, targetUserId);
      await this.audit.record(db, {
        organisationId,
        eventType: 'auth.mfa.admin_reset',
        actorUserAccountId: actor.id,
        entityType: 'user_account',
        entityRef: targetUserId,
      });
    });

    return { reset: true };
  }

  @AllowPreMfa()
  @AuthenticatedOnly()
  @Post('logout')
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const organisationId = (req as any).currentOrganisationId;
    const session = (req as any).currentSession;
    if (organisationId && session) {
      await withOrgContext(organisationId, (db) =>
        this.auth.logout(db, organisationId, session.id, session.userAccountId),
      );
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  }
}
