import { Controller, Get, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { withOrgContext } from '../../db/org-context';
import { getPool } from '../../db/pool';
import { RequirePermission } from '../../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../../rbac/permissions';
import { HealthDiagnosticsService } from './health-diagnostics.service';

/**
 * P3 items 19/20. Admin-gated (ORGANISATION_MANAGE, same permission as
 * every other installation-adjacent admin surface added this phase) -
 * distinct from HealthController's public, unauthenticated `/api/v1/health`
 * liveness probe (a bare {status:'ok'} for load balancers/uptime monitors,
 * which must stay public and minimal). This is the detailed operator view.
 */
@Controller('api/v1/system')
export class HealthDiagnosticsController {
  constructor(private readonly service: HealthDiagnosticsService) {}

  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Get('health')
  async getHealth(@Req() req: FastifyRequest) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, (db) => this.service.getSystemHealth(db, getPool(), organisationId));
  }

  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Get('diagnostics')
  async getDiagnostics(@Req() req: FastifyRequest) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, (db) => this.service.getDiagnostics(db, getPool()));
  }
}
