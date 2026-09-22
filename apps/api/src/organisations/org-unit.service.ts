import { Injectable, BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../db/types';

/** Organisational Units: configurable unit types, self-referencing hierarchy, org-scoped. P0 item 8. */
@Injectable()
export class OrgUnitService {
  async create(
    db: Kysely<Database>,
    organisationId: string,
    name: string,
    unitType: string,
    parentId?: string,
  ) {
    if (parentId) {
      const parent = await db
        .selectFrom('organisational_units')
        .select('id')
        .where('id', '=', parentId)
        .where('organisation_id', '=', organisationId)
        .executeTakeFirst();
      if (!parent)
        throw new BadRequestException('Parent organisational unit not found in this organisation.');
    }
    return db
      .insertInto('organisational_units')
      .values({
        organisation_id: organisationId,
        name,
        unit_type: unitType,
        parent_id: parentId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async list(db: Kysely<Database>, organisationId: string) {
    return db
      .selectFrom('organisational_units')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .execute();
  }
}
