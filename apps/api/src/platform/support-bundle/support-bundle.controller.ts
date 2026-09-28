import { Controller, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { withOrgContext } from '../../db/org-context';
import { getPool } from '../../db/pool';
import { RequirePermission } from '../../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../../rbac/permissions';
import { AuditService } from '../../audit/audit.service';
import { logStructured } from '../../logging/logger';
import { SupportBundleService } from './support-bundle.service';

/**
 * Support bundle admin endpoints (P3 item 21/8, HTTP surface) - the
 * underlying service (support-bundle.service.ts, with its extensive
 * canary secret-leakage test suite) was implemented and tested first,
 * without an HTTP surface; closed here the same way backup/update's gaps
 * were closed.
 *
 * "No automatic upload" (item 21) is structural here, not just policy:
 * this controller only ever RETURNS the bundle in the HTTP response body
 * to the requesting admin - nothing in this file, or in
 * SupportBundleService, ever makes an outbound network call anywhere.
 */
@Controller('api/v1/support-bundle')
export class SupportBundleController {
  constructor(
    private readonly service: SupportBundleService,
    private readonly audit: AuditService,
  ) {}

  /** Item 21: "preview categories before creation/download." */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Get('preview')
  previewCategories() {
    return { categories: this.service.previewCategories() };
  }

  /** Explicit administrator action (item 21) - always audited, never triggered by anything other than a direct admin request. */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Post()
  async generate(@Req() req: FastifyRequest) {
    const organisationId = (req as any).currentOrganisationId;
    const actor = (req as any).currentUser;

    const bundle = await withOrgContext(organisationId, (db) =>
      this.service.generate(db, getPool(), organisationId),
    );

    logStructured({
      event: 'support_bundle.generated',
      level: 'info',
      userRef: actor?.id,
      context: { organisationId },
    });
    await withOrgContext(organisationId, (db) =>
      this.audit.record(db, {
        organisationId,
        eventType: 'config.changed',
        actorUserAccountId: actor?.id,
        entityType: 'support_bundle',
        entityRef: bundle.generatedAt,
      }),
    );

    return bundle;
  }
}
