import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { withOrgContext } from '../../db/org-context';
import { RequirePermission } from '../../rbac/permission.guard';
import { BelongsToApp } from '../../platform/app-registry/application-active.guard';
import { AppContextFactory } from '../../platform/app-context.factory';
import { ReferenceService } from './reference.service';
import { REFERENCE_APP_MANIFEST } from './reference.manifest';
import { CreateWidgetDto, DecideDto } from './dto';

const APP_ID = REFERENCE_APP_MANIFEST.appId;

/**
 * Reference app HTTP surface. P1 item 17. Every route is gated behind
 * @BelongsToApp (ApplicationActiveGuard - 404 if this app isn't
 * enabled+licensed+compatible for the caller's organisation, per
 * Architecture §3) AND the normal PermissionGuard, exactly like a real
 * commercial app's controllers would be.
 */
@Controller('api/v1/apps/reference/widgets')
@BelongsToApp(APP_ID)
export class ReferenceController {
  constructor(
    private readonly reference: ReferenceService,
    private readonly contextFactory: AppContextFactory,
  ) {}

  @RequirePermission('reference.widget.create')
  @Post()
  async create(@Req() req: FastifyRequest, @Body() body: CreateWidgetDto) {
    const organisationId = (req as any).currentOrganisationId;
    const subject = (req as any).permissionSubject;
    const actor = (req as any).currentUser;

    return withOrgContext(organisationId, (db) => {
      const ctx = this.contextFactory.create(APP_ID, organisationId, subject.grantedPermissions, actor.id, db);
      return this.reference.createWidget(ctx, db, actor.id, body.title, body.warrantyStatus);
    });
  }

  @RequirePermission('reference.widget.submit')
  @Post(':id/submit')
  async submit(@Req() req: FastifyRequest, @Param('id') id: string) {
    const organisationId = (req as any).currentOrganisationId;
    const subject = (req as any).permissionSubject;
    const actor = (req as any).currentUser;

    return withOrgContext(organisationId, (db) => {
      const ctx = this.contextFactory.create(APP_ID, organisationId, subject.grantedPermissions, actor.id, db);
      return this.reference.submitWidget(ctx, db, actor.id, id);
    });
  }

  @RequirePermission('reference.widget.approve')
  @Post(':id/decide')
  async decide(@Req() req: FastifyRequest, @Param('id') id: string, @Body() body: DecideDto) {
    const organisationId = (req as any).currentOrganisationId;
    const subject = (req as any).permissionSubject;
    const actor = (req as any).currentUser;

    return withOrgContext(organisationId, (db) => {
      const ctx = this.contextFactory.create(APP_ID, organisationId, subject.grantedPermissions, actor.id, db);
      return this.reference.decide(ctx, db, actor.id, id, body.stepId, body.decision);
    });
  }

  @RequirePermission('reference.widget.view')
  @Get(':id')
  async get(@Req() req: FastifyRequest, @Param('id') id: string) {
    const organisationId = (req as any).currentOrganisationId;
    return withOrgContext(organisationId, (db) => this.reference.getWidget(db, organisationId, id));
  }
}
