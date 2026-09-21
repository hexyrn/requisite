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
      await db.destroy();
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
