import { Body, Controller, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import { TotpService } from './totp.service';
import { InstallationRepository } from '../bootstrap/installation.repository';
import { withOrgContext } from '../db/org-context';
import { PublicRoute } from '../http/session-auth.guard';
import { AuthenticatedOnly } from '../rbac/permission.guard';
import { encodeSessionCookie, decodeSessionCookie, SESSION_COOKIE_NAME } from '../http/session-cookie';
import { SessionService } from '../sessions/session.service';
import { UnauthorizedException, BadRequestException, ForbiddenException } from '@nestjs/common';

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
  ) {}

  @PublicRoute()
  @Post('login')
  async login(
    @Body() body: { email: string; password: string },
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const organisationId = await this.installations.getPrimaryOrganisationId();
    const outcome = await withOrgContext(organisationId, (db) =>
      this.auth.login(db, organisationId, body.email, body.password),
    );

    // The failure-bookkeeping (lockout counter, audit event) has already
    // been committed by AuthService.login regardless of outcome - see the
    // comment on that method. Only NOW do we decide what to tell the caller.
    if (!outcome.ok) {
      if (outcome.reason === 'locked') {
        throw new ForbiddenException('Account is temporarily locked due to repeated failed sign-in attempts.');
      }
      if (outcome.reason === 'inactive') {
        throw new ForbiddenException('Account is deactivated.');
      }
      // 'unknown-account' and 'bad-password' get the same message/shape -
      // no user-enumeration via response differences.
      throw new UnauthorizedException('Invalid email or password.');
    }

    res.setCookie(SESSION_COOKIE_NAME, encodeSessionCookie(organisationId, outcome.session.id), cookieOptions());

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
    @Body() body: { code: string },
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const organisationId = await this.installations.getPrimaryOrganisationId();
    const decoded = decodeSessionCookie((req as any).cookies?.[SESSION_COOKIE_NAME]);
    if (!decoded) {
      throw new UnauthorizedException('No pending session.');
    }

    const newSession = await withOrgContext(organisationId, async (db) => {
      const pending = await this.sessions.getActiveSession(db, decoded.sessionId);
      if (!pending) throw new UnauthorizedException('Session is invalid, expired, or revoked.');

      const valid = await this.totp.verifyChallenge(db, pending.userAccountId, body.code);
      if (!valid) throw new BadRequestException('Invalid MFA code.');

      return this.sessions.rotateSession(db, organisationId, pending.userAccountId, true, pending.id);
    });

    res.setCookie(SESSION_COOKIE_NAME, encodeSessionCookie(organisationId, newSession.id), cookieOptions());
    return { verified: true, csrfToken: newSession.csrfToken };
  }

  @AuthenticatedOnly()
  @Post('logout')
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) res: FastifyReply) {
    const organisationId = (req as any).currentOrganisationId;
    const session = (req as any).currentSession;
    if (organisationId && session) {
      await withOrgContext(organisationId, (db) => this.auth.logout(db, organisationId, session.id, session.userAccountId));
    }
    res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
    return { ok: true };
  }
}
