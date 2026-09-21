import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../db/types';

@Injectable()
export class RoleRepository {
  async getGrantedPermissions(db: Kysely<Database>, userAccountId: string): Promise<Set<string>> {
    const rows = await db
      .selectFrom('user_roles')
      .innerJoin('role_permissions', 'role_permissions.role_id', 'user_roles.role_id')
      .select('role_permissions.permission_key')
      .where('user_roles.user_account_id', '=', userAccountId)
      .execute();
    return new Set(rows.map((r) => r.permission_key));
  }
}
