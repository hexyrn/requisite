import { Controller, Get, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { withOrgContext } from '../../db/org-context';
import { AuthenticatedOnly } from '../../rbac/permission.guard';
import { LauncherService } from './launcher.service';

@Controller('api/v1/apps')
export class LauncherController {
  constructor(private readonly launcher: LauncherService) {}

  /** The apps this user can open from the Core home page / app switcher. */
  @AuthenticatedOnly()
  @Get('launcher')
  async get(@Req() req: FastifyRequest) {
    const organisationId = (req as any).currentOrganisationId;
    const subject = (req as any).permissionSubject;
    return withOrgContext(organisationId, (db) =>
      this.launcher.build(db, organisationId, subject.grantedPermissions),
    );
  }
}
