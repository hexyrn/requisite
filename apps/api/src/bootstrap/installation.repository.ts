import { Injectable, NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { Database } from '../db/types';
import { getPool } from '../db/pool';

/**
 * installations has no RLS (it is not organisation-owned data). This is the
 * one place the primary-organisation lookup happens without an org context
 * already established, which is unavoidable for v1's single-organisation
 * product behaviour (Architecture §7) - e.g. resolving which org a login
 * attempt is against, before any session exists.
 */
@Injectable()
export class InstallationRepository {
  async getPrimaryOrganisationId(pool: Pool = getPool()): Promise<string> {
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    try {
      const installation = await db.selectFrom('installations').selectAll().executeTakeFirst();
      const config = installation?.config as { primaryOrganisationId?: string } | undefined;
      if (!installation || !config?.primaryOrganisationId) {
        throw new NotFoundException('No organisation has been set up yet. Complete bootstrap first.');
      }
      return config.primaryOrganisationId;
    } finally {
      await db.destroy();
    }
  }
}
