import { Body, Controller, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { InvitationService } from './invitation.service';
import { InstallationRepository } from '../bootstrap/installation.repository';
import { withOrgContext } from '../db/org-context';
import { PublicRoute } from '../http/session-auth.guard';
import { RequirePermission } from '../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../rbac/permissions';
import { enforceRateLimit, invitationAcceptRateLimiters } from '../security/rate-limits';

@Controller('api/v1/auth/invitations')
export class InvitationController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly installations: InstallationRepository,
  ) {}

  /**
   * Admin-initiated - requires an authenticated admin with permission to
   * manage users. Unlike password reset, it's safe to hand the URL straight
   * back in this response: the caller IS the admin who is about to relay it
   * to the invitee themselves (P0 item 15 - "expose the invitation URL to
   * the admin instead of failing" when SMTP isn't configured).
   */
  @RequirePermission(CORE_PERMISSIONS.USERS_MANAGE)
  @Post()
  async create(@Req() req: FastifyRequest, @Body() body: { email: string; roleIds?: string[] }) {
    const organisationId = (req as any).currentOrganisationId;
    const actor = (req as any).currentUser;
    const baseUrl = `${req.protocol}://${req.hostname}`;
    return withOrgContext(organisationId, (db) =>
      this.invitations.createInvitation(db, organisationId, actor.id, body.email, body.roleIds ?? [], false, baseUrl),
    );
  }

  @PublicRoute()
  @Post('accept')
  async accept(@Req() req: FastifyRequest, @Body() body: { token: string; password: string }) {
    enforceRateLimit(invitationAcceptRateLimiters, body.token, req.ip);
    const organisationId = await this.installations.getPrimaryOrganisationId();
    return withOrgContext(organisationId, (db) => this.invitations.acceptInvitation(db, organisationId, body.token, body.password));
  }
}
