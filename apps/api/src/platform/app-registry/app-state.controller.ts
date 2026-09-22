import { Controller, Get, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { withOrgContext } from '../../db/org-context';
import { RequirePermission } from '../../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../../rbac/permissions';
import { ApplicationRegistryService } from './application-registry.service';

/**
 * Deliberately NOT gated by @BelongsToApp (ApplicationActiveGuard) -
 * that guard's whole point (Architecture §3) is to 404 an inactive app's
 * OWN routes so an unlicensed/unauthorised caller can never distinguish
 * "not installed" from "installed but not licensed for you." This
 * endpoint is the intentional exception: an ORG ADMIN (core.organisation.manage)
 * needs to see licensing status precisely so the UI can render "Hexyrn
 * Requisite - Not Licensed" instead of a broken app (item 21). Ordinary
 * users never reach this route (it requires an admin permission), and it
 * reveals nothing to a caller who cannot already see the org's admin
 * surface.
 */
@Controller('api/v1/apps')
export class AppStateController {
  constructor(private readonly registry: ApplicationRegistryService) {}

  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Get(':appId/state')
  async getState(@Req() req: FastifyRequest, @Param('appId') appId: string) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, (db) => this.registry.getApplicationState(db, organisationId, appId));
  }
}
