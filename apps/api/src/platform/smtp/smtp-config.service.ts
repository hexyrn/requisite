import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { encryptSecret, decryptSecret } from '../../security/secret-encryption';

/**
 * SMTP configuration storage (P3 item 9/24). Installation-level (SMTP is a
 * server/deployment concern, not per-organisation - consistent with
 * Architecture §7's v1 "exactly one organisation per installation" and
 * with how the licensing public key / release trust set are configured),
 * stored in the existing `installations.config` JSONB column rather than a
 * new table - no migration needed, same pattern as how other installation-
 * level settings already live there.
 *
 * SECURE CREDENTIAL HANDLING: the SMTP password is never stored in
 * plaintext - encryptSecret()/decryptSecret() (AES-256-GCM,
 * security/secret-encryption.ts, the same scheme webhook signing keys and
 * integration credentials already use) wraps it before it touches the
 * database. getConfigForDisplay() NEVER returns the password or its
 * ciphertext - only a `passwordSet: boolean` - so there is no code path
 * anywhere that lets an admin UI re-display a previously configured
 * password, matching the explicit instruction.
 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean; // true = implicit TLS on connect; false = plaintext-then-STARTTLS if the server offers it
  username: string | null;
  password: string | null; // plaintext - only ever present in the SET request, never in a GET response
  fromAddress: string;
}

export interface SmtpConfigForDisplay {
  configured: boolean;
  host: string | null;
  port: number | null;
  secure: boolean | null;
  username: string | null;
  passwordSet: boolean;
  fromAddress: string | null;
}

interface StoredSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  passwordEncrypted: string | null;
  fromAddress: string;
}

const CONFIG_KEY = 'smtp';

@Injectable()
export class SmtpConfigService {
  async setConfig(pool: Pool, config: SmtpConfig): Promise<void> {
    const stored: StoredSmtpConfig = {
      host: config.host,
      port: config.port,
      secure: config.secure,
      username: config.username,
      passwordEncrypted: config.password ? encryptSecret(config.password) : null,
      fromAddress: config.fromAddress,
    };
    // installations.config is a single JSONB blob shared by every
    // installation-level setting - merge in the smtp key rather than
    // overwriting the whole column, so unrelated settings stored there
    // survive an SMTP config change.
    await pool.query(
      `UPDATE installations SET config = jsonb_set(coalesce(config, '{}'::jsonb), $1, $2::jsonb, true)`,
      [`{${CONFIG_KEY}}`, JSON.stringify(stored)],
    );
  }

  async getConfigForSending(pool: Pool): Promise<SmtpConfig | null> {
    const stored = await this.readStored(pool);
    if (!stored) return null;
    return {
      host: stored.host,
      port: stored.port,
      secure: stored.secure,
      username: stored.username,
      password: stored.passwordEncrypted ? decryptSecret(stored.passwordEncrypted) : null,
      fromAddress: stored.fromAddress,
    };
  }

  /** Item 9/10: what the admin UI actually shows - never the password itself. */
  async getConfigForDisplay(pool: Pool): Promise<SmtpConfigForDisplay> {
    const stored = await this.readStored(pool);
    if (!stored) {
      return {
        configured: false,
        host: null,
        port: null,
        secure: null,
        username: null,
        passwordSet: false,
        fromAddress: null,
      };
    }
    return {
      configured: true,
      host: stored.host,
      port: stored.port,
      secure: stored.secure,
      username: stored.username,
      passwordSet: !!stored.passwordEncrypted,
      fromAddress: stored.fromAddress,
    };
  }

  async clearConfig(pool: Pool): Promise<void> {
    await pool.query(`UPDATE installations SET config = config - $1`, [CONFIG_KEY]);
  }

  private async readStored(pool: Pool): Promise<StoredSmtpConfig | null> {
    const result = await pool.query<{ config: Record<string, unknown> }>(
      'SELECT config FROM installations LIMIT 1',
    );
    const config = result.rows[0]?.config;
    if (!config || !config[CONFIG_KEY]) return null;
    return config[CONFIG_KEY] as StoredSmtpConfig;
  }
}
