import { Injectable, BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../db/types';

/** Locations: self-referencing hierarchical physical/logical locations, org-scoped. P0 item 9. */
@Injectable()
export class LocationService {
  async create(db: Kysely<Database>, organisationId: string, name: string, locationType?: string, parentId?: string) {
    if (parentId) {
      const parent = await db
        .selectFrom('locations')
        .select('id')
        .where('id', '=', parentId)
        .where('organisation_id', '=', organisationId)
        .executeTakeFirst();
      if (!parent) throw new BadRequestException('Parent location not found in this organisation.');
    }
    return db
      .insertInto('locations')
      .values({ organisation_id: organisationId, name, location_type: locationType ?? null, parent_id: parentId ?? null })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async list(db: Kysely<Database>, organisationId: string) {
    return db.selectFrom('locations').selectAll().where('organisation_id', '=', organisationId).execute();
  }
}
