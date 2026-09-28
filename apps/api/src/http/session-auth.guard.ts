import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { withOrgContext } from '../db/org-context';
import { SessionService } from '../sessions/session.service';
import { RoleRepository } from '../rbac/role.repository';
import { decodeSessionCookie, SESSION_COOKIE_NAME } from './session-cookie';
import { ServiceAccountService } from '../platform/api-access/service-account.service';

export const PUBLIC_ROUTE_KEY = 'hexyrn:public-route';
export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE_KEY, true);

/** Route that a password-only (pre-MFA) session may still call - only logout. */
export const ALLOW_PRE_MFA_KEY = 'hexyrn:allow-pre-mfa';
export const AllowPreMfa = () => SetMetadata(ALLOW_PRE_MFA_KEY, true);

/**
 * Resolves the session cookie into an authenticated permission-check subject
 * (Architecture §1's PermissionCheckSubject), running the lookup inside
 * withOrgContext so the sessions/user_accounts/roles reads are RLS-protected
 * like everything else. Runs before PermissionGuard. Routes must opt OUT via
 * @PublicRoute() (login, bootstrap) rather than opting in - deny-by-default.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly roles: RoleRepository,
    private readonly serviceAccounts: ServiceAccountService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.get<boolean | undefined>(
      PUBLIC_ROUTE_KEY,
      context.getHandler(),
    );
    const request = context.switchToHttp().getRequest();

    // P2 item 11: the Public REST API is authenticated by a service-account
    // API key (`Authorization: Bearer hxk_...`) instead of a session
    // cookie. Checked BEFORE the cookie path so an API-key caller never
    // needs a session at all; falls through to normal cookie handling
    // (including @PublicRoute()) for any request that doesn't present one.
    const authHeader: string | undefined = request.headers?.['authorization'];
    if (authHeader?.startsWith('Bearer hxk_')) {
      const auth = await this.serviceAccounts.authenticate(authHeader.slice('Bearer '.length).trim());
      if (!auth) throw new UnauthorizedException('Invalid or revoked API credential.');
      request.permissionSubject = this.serviceAccounts.toPermissionSubject(auth);
      request.currentOrganisationId = auth.organisationId;
      request.currentServiceAccountId = auth.serviceAccountId;
      return true;
    }

    const cookieHeader = request.cookies?.[SESSION_COOKIE_NAME];
    const decoded = decodeSessionCookie(cookieHeader);

    if (!decoded) {
      if (isPublic) return true;
      throw new UnauthorizedException('No session.');
    }

    const { organisationId, sessionId } = decoded;

    const resolved = await withOrgContext(organisationId, async (db) => {
      const session = await this.sessions.getActiveSession(db, sessionId);
      if (!session) return null;

      const user = await db
        .selectFrom('user_accounts')
        .selectAll()
        .where('id', '=', session.userAccountId)
        .executeTakeFirst();
      if (!user || !user.is_active) return null;

      const permissions = await this.roles.getGrantedPermissions(db, user.id);
      return { session, user, permissions };
    });

    if (!resolved) {
      if (isPublic) return true;
      throw new UnauthorizedException('Session is invalid, expired, or revoked.');
    }

    // Synchronizer-token CSRF check for state-changing cookie-authenticated
    // requests - Architecture §6. Defense-in-depth on top of SameSite=Lax.
    // Public routes (login, bootstrap) are exempt even when a still-valid
    // session cookie happens to be present (e.g. a user with an existing
    // session opens /login again): the client-side form for a @PublicRoute()
    // has no CSRF token to send yet, and re-authenticating with the correct
    // password is itself proof of intent, so gating it on a token the page
    // never had would just produce a confusing dead end.
    // MFA enforcement (Architecture §6): a session created by password login
    // alone is "pre-MFA" until /auth/mfa/verify rotates it into a verified
    // one. Without this check the second factor could be skipped entirely by
    // simply never calling /auth/mfa/verify. Keyed on the USER's current
    // mfa_enabled (not just the session flag) so sessions created before
    // login started recording mfa_verified correctly - which are all
    // mfa_verified=false, MFA or not - keep working for users without MFA.
    // Public routes (login, mfa/verify itself) and routes explicitly marked
    // @AllowPreMfa() (logout) stay reachable so a pending session can finish
    // or abandon the challenge.
    if (!isPublic && resolved.user.mfa_enabled && !resolved.session.mfaVerified) {
      const allowPreMfa = this.reflector.get<boolean | undefined>(
        ALLOW_PRE_MFA_KEY,
        context.getHandler(),
      );
      if (!allowPreMfa) {
        throw new UnauthorizedException('MFA verification required.');
      }
    }

    const mutating = !isPublic && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
    if (mutating) {
      const header = request.headers['x-hexyrn-csrf'];
      if (!header || header !== resolved.session.csrfToken) {
        throw new UnauthorizedException('Missing or invalid CSRF token.');
      }
    }

    request.permissionSubject = {
      userAccountId: resolved.user.id,
      organisationId,
      grantedPermissions: resolved.permissions,
    };
    request.currentSession = resolved.session;
    request.currentUser = resolved.user;
    request.currentOrganisationId = organisationId;

    return true;
  }
}
