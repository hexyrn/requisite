import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../db/types';

export interface CreatePersonInput {
  firstName: string;
  lastName: string;
  email?: string;
  organisationalUnitId?: string;
  locationId?: string;
}

/**
 * People: lightweight Person entity, optional link to a User Account,
 * org-scoped. Deliberately NO HR/payroll/performance fields. P0 item 10.
 */
@Injectable()
export class PersonService {
  async create(db: Kysely<Database>, organisationId: string, input: CreatePersonInput) {
    return db
      .insertInto('people')
      .values({
        organisation_id: organisationId,
        first_name: input.firstName,
        last_name: input.lastName,
        email: input.email ?? null,
        organisational_unit_id: input.organisationalUnitId ?? null,
        location_id: input.locationId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async list(db: Kysely<Database>, organisationId: string) {
    return db
      .selectFrom('people')
      .selectAll()
      .where('organisation_id', '=', organisationId)
      .execute();
  }

  /** Links a Person to a User Account (P0 item 11 - separate entities, optional FK). */
  async linkUserAccount(db: Kysely<Database>, personId: string, userAccountId: string) {
    await db
      .updateTable('user_accounts')
      .set({ person_id: personId })
      .where('id', '=', userAccountId)
      .execute();
  }
}
