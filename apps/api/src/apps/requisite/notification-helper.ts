import { Kysely } from 'kysely';
import { Database } from '../../db/types';

/**
 * Finds every user in the organisation who holds a given permission via
 * any of their roles - the same role_permissions/user_roles join
 * RoleRepository.getGrantedPermissions() uses in reverse. Used only to
 * decide WHO to notify (e.g. "everyone who can approve requisitions"),
 * never for an authorisation decision itself - every actual permission
 * CHECK still goes through the one PermissionEvaluator seam.
 */
export async function findUsersWithPermission(db: Kysely<Database>, organisationId: string, permissionKey: string): Promise<string[]> {
  const rows = await db
    .selectFrom('user_roles')
    .innerJoin('role_permissions', 'role_permissions.role_id', 'user_roles.role_id')
    .innerJoin('user_accounts', 'user_accounts.id', 'user_roles.user_account_id')
    .select('user_accounts.id')
    .where('role_permissions.permission_key', '=', permissionKey)
    .where('user_accounts.organisation_id', '=', organisationId)
    .where('user_accounts.is_active', '=', true)
    .distinct()
    .execute();
  return rows.map((r) => r.id);
}
