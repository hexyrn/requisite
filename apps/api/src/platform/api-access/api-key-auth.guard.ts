import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ServiceAccountService } from './service-account.service';

/**
 * Authenticates the Public REST API (P2 item 11) via a service-account API
 * key (`Authorization: Bearer hxk_...`) instead of the session cookie
 * SessionAuthGuard uses for the browser-facing app. Populates
 * request.permissionSubject in EXACTLY the same shape SessionAuthGuard does,
 * so PermissionGuard and every downstream handler work identically
 * regardless of which guard authenticated the caller - "no second
 * authorisation universe" (item 13).
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  constructor(private readonly serviceAccounts: ServiceAccountService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header: string | undefined = request.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing API credential.');
    }
    const plaintextKey = header.slice('Bearer '.length).trim();
    const auth = await this.serviceAccounts.authenticate(plaintextKey);
    if (!auth) {
      throw new UnauthorizedException('Invalid or revoked API credential.');
    }

    request.permissionSubject = this.serviceAccounts.toPermissionSubject(auth);
    request.currentOrganisationId = auth.organisationId;
    request.currentServiceAccountId = auth.serviceAccountId;
    request.currentCredentialId = auth.credentialId;

    return true;
  }
}
