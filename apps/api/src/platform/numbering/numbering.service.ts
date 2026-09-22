import { Injectable, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { Database } from '../../db/types';

export interface RegisterSequenceInput {
  appId: string;
  sequenceKey: string;
  prefix?: string;
  padLength?: number;
  yearReset?: boolean;
}

/**
 * Numbering engine. Architecture-implied concurrency-safety requirement,
 * P1 item 8. `next()` is a SINGLE atomic `UPDATE ... RETURNING` statement -
 * Postgres takes a row lock for the duration of that statement, so two
 * concurrent callers incrementing the same sequence are serialized by
 * Postgres itself, not by application-level locking. Whichever transaction
 * commits second simply sees the already-incremented value and increments
 * again - there is no window where both could read the same starting value.
 * This is verified by a genuine concurrency test (many parallel connections
 * calling `next()` on the same sequence, asserting the resulting set of
 * numbers has no duplicates and is a contiguous run).
 */
@Injectable()
export class NumberingService {
  async registerSequence(
    db: Kysely<Database>,
    organisationId: string,
    input: RegisterSequenceInput,
  ): Promise<void> {
    await db
      .insertInto('numbering_sequences')
      .values({
        organisation_id: organisationId,
        app_id: input.appId,
        sequence_key: input.sequenceKey,
        prefix: input.prefix ?? '',
        pad_length: input.padLength ?? 6,
        year_reset: input.yearReset ?? false,
      })
      .onConflict((oc) => oc.columns(['organisation_id', 'app_id', 'sequence_key']).doNothing())
      .execute();
  }

  /** Issues the next formatted number for this sequence, e.g. "REQ-000001" or "PO-2026-000001". */
  async next(
    db: Kysely<Database>,
    organisationId: string,
    appId: string,
    sequenceKey: string,
  ): Promise<string> {
    const currentYear = new Date().getFullYear();

    // A single atomic UPDATE...RETURNING - see the class doc comment for
    // why this is what makes concurrent calls safe. Written as raw SQL
    // (rather than Kysely's query builder) because the CASE expressions
    // needed for year-reset semantics, combined with the bigint column
    // being surfaced as `string` in TypeScript, fight Kysely's type
    // inference for no safety benefit - every value here is either a
    // bound parameter or a column reference, never interpolated text.
    const result = await sql<{
      current_value: string;
      prefix: string;
      pad_length: number;
      year_reset: boolean;
      last_reset_year: number | null;
    }>`
      UPDATE numbering_sequences
      SET
        current_value = CASE
          WHEN year_reset AND last_reset_year IS DISTINCT FROM ${currentYear} THEN 1
          ELSE current_value + 1
        END,
        last_reset_year = CASE WHEN year_reset THEN ${currentYear} ELSE last_reset_year END
      WHERE organisation_id = ${organisationId} AND app_id = ${appId} AND sequence_key = ${sequenceKey}
      RETURNING current_value, prefix, pad_length, year_reset, last_reset_year
    `.execute(db);

    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException(
        `Numbering sequence "${sequenceKey}" is not registered for app "${appId}" in this organisation.`,
      );
    }

    const paddedValue = String(row.current_value).padStart(row.pad_length, '0');
    const yearSegment = row.year_reset ? `${row.last_reset_year}-` : '';
    return `${row.prefix}${yearSegment}${paddedValue}`;
  }
}
