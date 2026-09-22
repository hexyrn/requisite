import { Body, Controller, ForbiddenException, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { InvitationService } from './invitation.service';
import { InstallationRepository } from '../bootstrap/installation.repository';
import { withOrgContext } from '../db/org-context';
import { PublicRoute } from '../http/session-auth.guard';
import { RequirePermission } from '../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../rbac/permissions';
import { RoleRepository } from '../rbac/role.repository';
import { enforceRateLimit, invitationAcceptRateLimiters } from '../security/rate-limits';

@Controller('api/v1/auth/invitations')
export class InvitationController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly installations: InstallationRepository,
    private readonly roles: RoleRepository,
  ) {}

  /**
   * Admin-initiated - requires an authenticated admin with permission to
   * manage users. Unlike password reset, it's safe to hand the URL straight
   * back in this response: the caller IS the admin who is about to relay it
   * to the invitee themselves (P0 item 15 - "expose the invitation URL to
   * the admin instead of failing" when SMTP isn't configured).
   *
   * SECURITY: privilege-escalation guard, found during the P0 security
   * review. `core.users.manage` alone does not imply the actor should be
   * able to grant ANY role in the org - without this check, a user holding
   * a lesser role that happens to include users.manage could invite someone
   * (including a fresh account they control) straight into the Owner role,
   * which holds every permission. An actor may only grant roles whose
   * permission set is a SUBSET of their own currently granted permissions -
   * "you cannot hand out a key you don't hold yourself."
   */
  @RequirePermission(CORE_PERMISSIONS.USERS_MANAGE)
  @Post()
  async create(@Req() req: FastifyRequest, @Body() body: { email: string; roleIds?: string[] }) {
    const organisationId = (req as any).currentOrganisationId;
    const actor = (req as any).currentUser;
    const roleIds = body.roleIds ?? [];
    const baseUrl = `${req.protocol}://${req.hostname}`;

    return withOrgContext(organisationId, async (db) => {
      if (roleIds.length > 0) {
        const actorPermissions = await this.roles.getGrantedPermissions(db, actor.id);
        for (const roleId of roleIds) {
          const rolePermissions = await db
            .selectFrom('role_permissions')
            .select('permission_key')
            // RLS already confines this to the current org, but the explicit
            // filter documents the intent and protects the query even if
            // RLS were ever misconfigured (defense in depth, not reliance).
            .where('organisation_id', '=', organisationId)
            .where('role_id', '=', roleId)
            .execute();
          const exceedsActorPermissions = rolePermissions.some(
            (rp) => !actorPermissions.has(rp.permission_key),
          );
          if (exceedsActorPermissions) {
            throw new ForbiddenException(
              'Cannot invite a user into a role that grants permissions you do not hold.',
            );
          }
        }
      }

      return this.invitations.createInvitation(
        db,
        organisationId,
        actor.id,
        body.email,
        roleIds,
        false,
        baseUrl,
      );
    });
  }

  @PublicRoute()
  @Post('accept')
  async accept(@Req() req: FastifyRequest, @Body() body: { token: string; password: string }) {
    enforceRateLimit(invitationAcceptRateLimiters, body.token, req.ip);
    const organisationId = await this.installations.getPrimaryOrganisationId();
    return withOrgContext(organisationId, (db) =>
      this.invitations.acceptInvitation(db, organisationId, body.token, body.password),
    );
  }
}
