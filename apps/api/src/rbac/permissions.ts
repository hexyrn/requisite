/**
 * Flat, namespaced permission strings - Architecture §1. This is a plain
 * catalogue, not a table; new permissions are added here as app/Core
 * features are built. P0 defines only the permissions P0 itself needs.
 */
export const CORE_PERMISSIONS = {
  ORGANISATION_MANAGE: 'core.organisation.manage',
  USERS_MANAGE: 'core.users.manage',
  ROLES_MANAGE: 'core.roles.manage',
  PEOPLE_MANAGE: 'core.people.manage',
  PEOPLE_VIEW: 'core.people.view',
  ORG_UNITS_MANAGE: 'core.org_units.manage',
  LOCATIONS_MANAGE: 'core.locations.manage',
  AUDIT_VIEW: 'core.audit.view',
} as const;

export type CorePermission = (typeof CORE_PERMISSIONS)[keyof typeof CORE_PERMISSIONS];

export const ALL_CORE_PERMISSIONS: string[] = Object.values(CORE_PERMISSIONS);
