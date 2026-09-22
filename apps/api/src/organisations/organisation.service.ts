import { Injectable, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../db/types';

export interface UpdateOrganisationInput {
  displayName?: string;
  defaultCurrency?: string;
  timezone?: string;
  locale?: string;
  financialYearStartMonth?: number;
  address?: Record<string, unknown>;
  contact?: Record<string, unknown>;
  preferences?: Record<string, unknown>;
  logoFileRef?: string | null;
}

/** Organisation entity access. P0 item 7. Always called inside withOrgContext. */
@Injectable()
export class OrganisationService {
  async get(db: Kysely<Database>, organisationId: string) {
    const row = await db
      .selectFrom('organisations')
      .selectAll()
      .where('id', '=', organisationId)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('Organisation not found.');
    return row;
  }

  async update(db: Kysely<Database>, organisationId: string, input: UpdateOrganisationInput) {
    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (input.displayName !== undefined) updates.display_name = input.displayName;
    if (input.defaultCurrency !== undefined) updates.default_currency = input.defaultCurrency;
    if (input.timezone !== undefined) updates.timezone = input.timezone;
    if (input.locale !== undefined) updates.locale = input.locale;
    if (input.financialYearStartMonth !== undefined)
      updates.financial_year_start_month = input.financialYearStartMonth;
    if (input.address !== undefined) updates.address = input.address;
    if (input.contact !== undefined) updates.contact = input.contact;
    if (input.preferences !== undefined) updates.preferences = input.preferences;
    if (input.logoFileRef !== undefined) updates.logo_file_ref = input.logoFileRef;

    return db
      .updateTable('organisations')
      .set(updates as any)
      .where('id', '=', organisationId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
