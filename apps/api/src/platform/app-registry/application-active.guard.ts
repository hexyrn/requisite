import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApplicationRegistryService } from './application-registry.service';
import { withOrgContext } from '../../db/org-context';

export const APP_ID_KEY = 'hexyrn:app-id';
/** Marks a controller/route as belonging to a specific installable app - gated by ApplicationActiveGuard. */
export const BelongsToApp = (appId: string) => SetMetadata(APP_ID_KEY, appId);

/**
 * Architecture §3's inactivity invariant, enforced structurally: "commercial
 * app controllers are registered behind a Nest guard evaluated before the
 * app's own route handlers ... that checks the full enabled ∧ licensed ∧
 * compatible state on every request and returns 404 (not 403, to avoid
 * confirming the route's existence) if not active."
 */
@Injectable()
export class ApplicationActiveGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly registry: ApplicationRegistryService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const appId =
      this.reflector.get<string | undefined>(APP_ID_KEY, context.getHandler()) ??
      this.reflector.get<string | undefined>(APP_ID_KEY, context.getClass());
    if (!appId) {
      // Not an app-gated route (e.g. Core's own controllers) - nothing to check.
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const organisationId = request.currentOrganisationId;
    if (!organisationId) {
      // No session resolved - SessionAuthGuard already handles the
      // unauthenticated case; if we somehow get here without an org, fail closed.
      throw new NotFoundException();
    }

    const state = await withOrgContext(organisationId, (db) =>
      this.registry.getApplicationState(db, organisationId, appId),
    );
    if (!state.active) {
      // 404, not 403 - never confirm the route/app exists to an unentitled caller.
      throw new NotFoundException();
    }
    return true;
  }
}
