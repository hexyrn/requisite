import { Controller, Get, NotFoundException, Post, Query, Req, Body } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { withOrgContext } from '../../db/org-context';
import { AuthenticatedOnly } from '../../rbac/permission.guard';
import { ReportQueryService } from './report-query.service';

/**
 * Core's generic report interface (item 15 - "integrate Requisite report
 * registrations into Core's report interface... no separate Requisite
 * reporting engine"). Deliberately NOT Requisite-specific: any app's
 * report_templates row can be listed/run through this one controller,
 * exactly the same way any app's dataset can be queried through the one
 * ReportQueryService. Templates are installation-level metadata (like a
 * form/workflow definition), listable by any authenticated user; actually
 * RUNNING one is still fully permission-gated by ReportQueryService's own
 * dataset-permission check against the CALLER's real permission set - a
 * template never bypasses that.
 */
@Controller('api/v1/reports')
export class ReportsController {
  constructor(private readonly queryEngine: ReportQueryService) {}

  @AuthenticatedOnly()
  @Get('templates')
  async listTemplates(@Req() req: FastifyRequest, @Query('appId') appId: string) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, (db) =>
      db
        .selectFrom('report_templates')
        .select(['template_key', 'app_id', 'name', 'primary_dataset'])
        .where('app_id', '=', appId)
        .execute(),
    );
  }

  @AuthenticatedOnly()
  @Post('execute')
  async execute(@Req() req: FastifyRequest, @Body() body: { templateKey: string }) {
    const organisationId = (req as any).currentOrganisationId;
    const subject = (req as any).permissionSubject;
    return withOrgContext(organisationId, async (db) => {
      const template = await db
        .selectFrom('report_templates')
        .selectAll()
        .where('template_key', '=', body.templateKey)
        .executeTakeFirst();
      if (!template)
        throw new NotFoundException(`Report template "${body.templateKey}" not found.`);
      return {
        name: template.name,
        rows: await this.queryEngine.execute(db, subject, template.definition as any),
      };
    });
  }
}
