import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FlatRolePermissionEvaluator } from './permission-evaluator';
import { PUBLIC_ROUTE_KEY } from '../http/session-auth.guard';

export const PERMISSION_KEY = 'hexyrn:required-permission';
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_KEY, permission);

/** Route requires a valid authenticated session but no specific permission (e.g. logout, "who am I"). */
export const AUTHENTICATED_ONLY_KEY = 'hexyrn:authenticated-only';
export const AuthenticatedOnly = () => SetMetadata(AUTHENTICATED_ONLY_KEY, true);

/**
 * Every route that touches organisation-scoped data goes through this guard.
 * Deny-by-default: no @RequirePermission metadata means the route is
 * unreachable (fails closed) rather than implicitly public - routes that are
 * genuinely public (login, bootstrap) must not use this guard at all, which
 * is itself an explicit, reviewable statement in the controller.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly evaluator = new FlatRolePermissionEvaluator();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.get<boolean | undefined>(
      PUBLIC_ROUTE_KEY,
      context.getHandler(),
    );
    if (isPublic) return true;

    const authenticatedOnly = this.reflector.get<boolean | undefined>(
      AUTHENTICATED_ONLY_KEY,
      context.getHandler(),
    );
    const required = this.reflector.get<string | undefined>(PERMISSION_KEY, context.getHandler());

    if (!required && !authenticatedOnly) {
      throw new ForbiddenException(
        'Route has no declared permission requirement - denied by default.',
      );
    }

    const request = context.switchToHttp().getRequest();

    if (!required && authenticatedOnly) {
      if (!request.permissionSubject) {
        throw new UnauthorizedException('No authenticated session.');
      }
      return true;
    }
    const subject = request.permissionSubject;
    if (!subject) {
      throw new UnauthorizedException('No authenticated session.');
    }

    const context_ = request.permissionContext;
    const allowed = this.evaluator.check(subject, required as string, context_);
    if (!allowed) {
      throw new ForbiddenException(`Missing required permission: ${required}`);
    }
    return true;
  }
}
