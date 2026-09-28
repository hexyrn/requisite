import { Controller, Get, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { withOrgContext } from '../db/org-context';
import { RequirePermission } from '../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../rbac/permissions';

/**
 * Read-only directory for the Users admin page: who has an account and which roles exist (so an invitation
 * can pick one). Changing access still goes through the existing, separately guarded invitation and MFA-reset
 * endpoints. Never returns password hashes, MFA secrets or recovery codes.
 */
@Controller('api/v1')
export class UsersAdminController {
  @RequirePermission(CORE_PERMISSIONS.USERS_MANAGE)
  @Get('users')
  async listUsers(@Req() req: FastifyRequest) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, async (db) => {
      const users = await db
        .selectFrom('user_accounts')
        .select(['id', 'email', 'is_active', 'mfa_enabled'])
        .where('organisation_id', '=', organisationId)
        .orderBy('email')
        .execute();
      const assignments = await db
        .selectFrom('user_roles')
        .innerJoin('roles', 'roles.id', 'user_roles.role_id')
        .select(['user_roles.user_account_id as userId', 'roles.name as roleName'])
        .where('user_roles.organisation_id', '=', organisationId)
        .execute();
      return {
        users: users.map((u) => ({
          id: u.id,
          email: u.email,
          isActive: u.is_active,
          mfaEnabled: u.mfa_enabled,
          roles: assignments.filter((a) => a.userId === u.id).map((a) => a.roleName),
        })),
      };
    });
  }

  @RequirePermission(CORE_PERMISSIONS.USERS_MANAGE)
  @Get('roles')
  async listRoles(@Req() req: FastifyRequest) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, async (db) => {
      const roles = await db
        .selectFrom('roles')
        .select(['id', 'name'])
        .where('organisation_id', '=', organisationId)
        .orderBy('name')
        .execute();
      const counts = await db
        .selectFrom('role_permissions')
        .select(['role_id', (eb) => eb.fn.countAll<string>().as('n')])
        .where('organisation_id', '=', organisationId)
        .groupBy('role_id')
        .execute();
      return {
        roles: roles.map((r) => ({
          id: r.id,
          name: r.name,
          permissionCount: Number(counts.find((c) => c.role_id === r.id)?.n ?? 0),
        })),
      };
    });
  }
}
