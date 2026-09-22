import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { OrganisationService, UpdateOrganisationInput } from './organisation.service';
import { withOrgContext } from '../db/org-context';
import { RequirePermission, AuthenticatedOnly } from '../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../rbac/permissions';

@Controller('api/v1/organisation')
export class OrganisationController {
  constructor(private readonly organisations: OrganisationService) {}

  @AuthenticatedOnly()
  @Get()
  async get(@Req() req: FastifyRequest) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, (db) => this.organisations.get(db, organisationId));
  }

  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Patch()
  async update(@Req() req: FastifyRequest, @Body() body: UpdateOrganisationInput) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, (db) =>
      this.organisations.update(db, organisationId, body),
    );
  }
}
