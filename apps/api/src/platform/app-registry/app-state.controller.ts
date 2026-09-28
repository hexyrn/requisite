import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { withOrgContext } from '../../db/org-context';
import { RequirePermission } from '../../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../../rbac/permissions';
import { ApplicationRegistryService } from './application-registry.service';
import { AuditService } from '../../audit/audit.service';

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
  constructor(
    private readonly registry: ApplicationRegistryService,
    private readonly audit: AuditService,
  ) {}

  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Get(':appId/state')
  async getState(@Req() req: FastifyRequest, @Param('appId') appId: string) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, (db) =>
      this.registry.getApplicationState(db, organisationId, appId),
    );
  }

  /** P3 item 10/25: the full licence administration detail view. */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Get(':appId/licence')
  async getLicence(@Req() req: FastifyRequest, @Param('appId') appId: string) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, (db) =>
      this.registry.getLicenceDetail(db, organisationId, appId),
    );
  }

  /**
   * P3 item 10/25: "authorised admins can import licence files." Verified
   * offline (LicenseVerifier - pure local Ed25519 cryptography, no network
   * call) via ApplicationRegistryService.grantLicense, which rejects
   * anything that doesn't verify. No internet activation required, per
   * Architecture §9.
   */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Post(':appId/licence')
  async importLicence(
    @Req() req: FastifyRequest,
    @Param('appId') appId: string,
    @Body() body: { majorVersion: number; licence: Record<string, unknown> },
  ) {
    const organisationId = (req as any).currentOrganisationId;
    const userId = (req as any).currentUser?.id;
    // One transaction: a licence that verifies and the activation it
    // triggers either both happen or neither does.
    const activated = await withOrgContext(organisationId, async (db) => {
      await this.registry.grantLicense(db, organisationId, appId, body.majorVersion, body.licence);
      const first = await this.registry.activateOnFirstLicence(db, organisationId, appId);
      await this.audit.record(db, {
        organisationId,
        eventType: first ? 'app.activated' : 'app.licence_imported',
        actorUserAccountId: userId,
        entityType: 'application',
        entityRef: appId,
      });
      return first;
    });
    const detail = await withOrgContext(organisationId, (db) =>
      this.registry.getLicenceDetail(db, organisationId, appId),
    );
    return { ...detail, activated };
  }
}
