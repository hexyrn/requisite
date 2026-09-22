import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { Database } from '../db/types';
import { getPool } from '../db/pool';
import { generateSecureToken, hashToken } from '../security/tokens';
import { logStructured } from '../logging/logger';
import { writeFileSync } from 'fs';
import { join } from 'path';

const CORE_VERSION = '0.1.0-p0';

export interface EnsureInstallationResult {
  installationId: string;
  /** Only populated when a NEW bootstrap token was just generated (first run). */
  plaintextBootstrapToken?: string;
}

/**
 * Installation entity + secure bootstrap flow start. P0 items 5 and 6.
 *
 * On first boot (no installations row exists): creates the installation,
 * generates a cryptographically secure one-time setup token, and exposes it
 * ONLY to the server operator - written to stdout as a structured log line
 * and to a locally-readable file (bootstrap-token.txt, gitignored, never
 * served over HTTP) - never emailed, never returned in any API response.
 */
@Injectable()
export class InstallationService {
  async ensureInstallation(pool: Pool = getPool()): Promise<EnsureInstallationResult> {
    // NOTE: deliberately do NOT call db.destroy() in a finally block here.
    // Kysely's PostgresDialect.destroy() calls pool.end() on whatever pool
    // it was given - since `pool` is the shared, caller-owned pool (the
    // default is the process-wide getPool() singleton, and tests pass in
    // their own shared pool used across many calls), destroying this
    // throwaway Kysely wrapper would end the SHARED pool out from under
    // every other concurrent/future caller. This is a real bug that was
    // caught empirically (tests failed with "Cannot use a pool after
    // calling end on the pool") - the pool's lifecycle belongs to whoever
    // constructed/injected it, never to a function that merely borrows it.
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    try {
      const existing = await db.selectFrom('installations').selectAll().executeTakeFirst();
      if (existing) {
        return { installationId: existing.id };
      }

      const installation = await db
        .insertInto('installations')
        .values({ core_version: CORE_VERSION, config: {} as any })
        .returningAll()
        .executeTakeFirstOrThrow();

      const plaintextToken = generateSecureToken(32);
      await db
        .insertInto('bootstrap_tokens')
        .values({
          installation_id: installation.id,
          token_hash: hashToken(plaintextToken),
        })
        .execute();

      this.exposeTokenToOperator(plaintextToken);

      return { installationId: installation.id, plaintextBootstrapToken: plaintextToken };
    } finally {
      // See the note above the `db` declaration - never destroy a shared pool here.
    }
  }

  private exposeTokenToOperator(token: string): void {
    logStructured({
      event: 'bootstrap.token_generated',
      context: {
        message:
          'First-run bootstrap token generated. Use it once to complete setup, then it is permanently invalidated.',
      },
    });
    // eslint-disable-next-line no-console
    console.log(`\n=== HEXYRN CORE FIRST-RUN SETUP TOKEN ===\n${token}\n==========================================\n`);
    try {
      const path = join(process.cwd(), 'bootstrap-token.txt');
      writeFileSync(path, token + '\n', { mode: 0o600 });
    } catch {
      // Best-effort only - stdout above is the guaranteed delivery path.
    }
  }
}
