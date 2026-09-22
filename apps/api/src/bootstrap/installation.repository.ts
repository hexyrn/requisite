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
    // Deliberately does not call db.destroy() - `pool` is shared/caller-owned
    // (see the identical, empirically-found bug and note in
    // installation.service.ts). Destroying it here would end the pool for
    // every other concurrent caller.
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    const installation = await db.selectFrom('installations').selectAll().executeTakeFirst();
    const config = installation?.config as { primaryOrganisationId?: string } | undefined;
    if (!installation || !config?.primaryOrganisationId) {
      throw new NotFoundException('No organisation has been set up yet. Complete bootstrap first.');
    }
    return config.primaryOrganisationId;
  }
}
