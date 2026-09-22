import { Body, Controller, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PasswordResetService } from './password-reset.service';
import { InstallationRepository } from '../bootstrap/installation.repository';
import { withOrgContext } from '../db/org-context';
import { PublicRoute } from '../http/session-auth.guard';
import {
  enforceRateLimit,
  passwordResetRequestRateLimiters,
  passwordResetSubmitRateLimiters,
} from '../security/rate-limits';
import { logStructured } from '../logging/logger';

@Controller('api/v1/auth/password-reset')
export class PasswordResetController {
  constructor(
    private readonly passwordReset: PasswordResetService,
    private readonly installations: InstallationRepository,
  ) {}

  /**
   * Self-service password reset request. Unlike invitations (P0 item 15,
   * admin-initiated - the URL is safe to hand straight back to the
   * authenticated admin who requested it), this endpoint is called
   * anonymously by whoever claims to own `email`. The reset URL/token must
   * NEVER be returned in this HTTP response - doing so would let anyone
   * take over any account just by knowing its email address. With no
   * notifications subsystem yet (P1), the URL is instead written to the
   * structured server log for the operator to relay out-of-band, the same
   * pattern as the bootstrap token. The response is identical whether or
   * not the account exists, to avoid user-enumeration.
   */
  @PublicRoute()
  @Post('request')
  async requestReset(@Req() req: FastifyRequest, @Body() body: { email: string }) {
    enforceRateLimit(passwordResetRequestRateLimiters, body.email, req.ip);

    const organisationId = await this.installations.getPrimaryOrganisationId();
    await withOrgContext(organisationId, async (db) => {
      const user = await db
        .selectFrom('user_accounts')
        .select(['id', 'is_active'])
        .where('organisation_id', '=', organisationId)
        .where('email', '=', body.email)
        .executeTakeFirst();

      if (user && user.is_active) {
        const token = await this.passwordReset.requestReset(db, organisationId, user.id);
        logStructured({
          event: 'password_reset.requested',
          userRef: user.id,
          context: {
            message: 'SMTP not configured in P0 - operator must relay this reset URL out-of-band.',
            resetUrl: `/reset-password?token=${token}`,
          },
        });
      }
      // Deliberately no branch for "account not found" - same response either way.
    });

    return { ok: true };
  }

  @PublicRoute()
  @Post('submit')
  async submitReset(
    @Req() req: FastifyRequest,
    @Body() body: { token: string; newPassword: string },
  ) {
    // Keyed by the token itself (opaque, high-entropy) rather than an
    // account, since we don't know which account it belongs to without
    // looking it up - and we don't want to do that DB work before rate
    // limiting an unauthenticated caller.
    enforceRateLimit(passwordResetSubmitRateLimiters, body.token, req.ip);

    const organisationId = await this.installations.getPrimaryOrganisationId();
    await withOrgContext(organisationId, (db) =>
      this.passwordReset.completeReset(db, organisationId, body.token, body.newPassword),
    );
    return { ok: true };
  }
}
