/**
 * Shared TypeScript types used across apps/api, apps/web, and future Hexyrn
 * apps built on Core. P0 keeps this deliberately small: only the shapes that
 * already have more than one consumer. Do not add speculative types here.
 */

export type UUID = string;

export interface InstallationSummary {
  id: UUID;
  coreVersion: string;
  createdAt: string;
}

export interface OrganisationSummary {
  id: UUID;
  name: string;
  displayName: string;
  defaultCurrency: string;
  timezone: string;
  locale: string;
}

export interface AuthenticatedUserSummary {
  id: UUID;
  organisationId: UUID;
  personId: UUID | null;
  email: string;
  isActive: boolean;
  mfaEnabled: boolean;
  permissions: string[];
}

export interface SessionBootstrapResponse {
  user: AuthenticatedUserSummary;
  organisation: OrganisationSummary;
  csrfToken: string;
}

/** Flat permission string, e.g. "core.users.manage". Never a scoped object in v1 - see Architecture §1. */
export type PermissionKey = string;

export interface ApiErrorBody {
  errorCode: string;
  message: string;
  correlationId: string;
}
