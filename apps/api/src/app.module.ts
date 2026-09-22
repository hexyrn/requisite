import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditService } from './audit/audit.service';
import { SessionService } from './sessions/session.service';
import { RoleRepository } from './rbac/role.repository';
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { TotpService } from './auth/totp.service';
import { PasswordResetService } from './auth/password-reset.service';
import { PasswordResetController } from './auth/password-reset.controller';
import { InvitationService } from './auth/invitation.service';
import { InvitationController } from './auth/invitation.controller';
import { BootstrapService } from './bootstrap/bootstrap.service';
import { BootstrapController } from './bootstrap/bootstrap.controller';
import { InstallationService } from './bootstrap/installation.service';
import { InstallationRepository } from './bootstrap/installation.repository';
import { OrganisationService } from './organisations/organisation.service';
import { OrganisationController } from './organisations/organisation.controller';
import { OrgUnitService } from './organisations/org-unit.service';
import { LocationService } from './organisations/location.service';
import { PersonService } from './organisations/person.service';
import { SessionAuthGuard } from './http/session-auth.guard';
import { PermissionGuard } from './rbac/permission.guard';
import { HealthController } from './health/health.controller';
import { PlatformModule } from './platform/platform.module';
import { ApplicationActiveGuard } from './platform/app-registry/application-active.guard';
import { ReferenceAppModule } from './apps/reference/reference.module';

@Module({
  imports: [PlatformModule, ReferenceAppModule],
  controllers: [
    BootstrapController,
    AuthController,
    PasswordResetController,
    InvitationController,
    OrganisationController,
    HealthController,
  ],
  providers: [
    AuditService,
    SessionService,
    RoleRepository,
    AuthService,
    TotpService,
    PasswordResetService,
    InvitationService,
    BootstrapService,
    InstallationService,
    InstallationRepository,
    OrganisationService,
    OrgUnitService,
    LocationService,
    PersonService,
    // Order matters: session resolution -> app-active state (404, never
    // reveal that a route exists behind an inactive app) -> permission checks.
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: ApplicationActiveGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule {}
