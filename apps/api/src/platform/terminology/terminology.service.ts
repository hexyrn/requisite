import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';

/**
 * Terminology mechanism. Architecture-required, P1 item 7. `resolve`
 * returns an org-configured display override if one exists, otherwise the
 * app-supplied fallback. This is the ONLY thing terminology affects -
 * `termKey` itself is the stable identifier used everywhere else (API
 * routes, permission keys, event names, migration identifiers), and
 * changing a display override here never touches any of those.
 */
@Injectable()
export class TerminologyService {
  async resolve(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
    termKey: string,
    fallback: string,
  ): Promise<string> {
    const row = await db
      .selectFrom('terminology_overrides')
      .select('display_value')
      .where('organisation_id', '=', organisationId)
      .where('app_id', '=', appId)
      .where('term_key', '=', termKey)
      .executeTakeFirst();
    return row?.display_value ?? fallback;
  }

  async setOverride(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
    termKey: string,
    displayValue: string,
  ): Promise<void> {
    await db
      .insertInto('terminology_overrides')
      .values({
        organisation_id: organisationId,
        app_id: appId,
        term_key: termKey,
        display_value: displayValue,
      })
      .onConflict((oc) =>
        oc
          .columns(['organisation_id', 'app_id', 'term_key'])
          .doUpdateSet({ display_value: displayValue, updated_at: new Date() }),
      )
      .execute();
  }

  async getAllOverrides(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
  ): Promise<Record<string, string>> {
    const rows = await db
      .selectFrom('terminology_overrides')
      .select(['term_key', 'display_value'])
      .where('organisation_id', '=', organisationId)
      .where('app_id', '=', appId)
      .execute();
    return Object.fromEntries(rows.map((r) => [r.term_key, r.display_value]));
  }
}
