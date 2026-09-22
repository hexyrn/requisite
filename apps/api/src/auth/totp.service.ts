import { Injectable, BadRequestException } from '@nestjs/common';
import { authenticator } from 'otplib';
import { Kysely } from 'kysely';
import { Database } from '../db/types';
import { encryptTotpSecret, decryptTotpSecret, rotateMasterKeyWrapping } from '../security/totp-encryption';
import { hashToken, generateNumericRecoveryCode } from '../security/tokens';

const RECOVERY_CODE_COUNT = 10;

export interface EnrolmentResult {
  secret: string;
  otpauthUrl: string;
  recoveryCodes: string[];
}

/** RFC 6238 TOTP enrolment/verification + recovery codes. P0 item 16. */
@Injectable()
export class TotpService {
  beginEnrolment(accountLabel: string, issuer = 'Hexyrn'): { secret: string; otpauthUrl: string } {
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(accountLabel, issuer, secret);
    return { secret, otpauthUrl };
  }

  verifyCode(secret: string, code: string): boolean {
    try {
      return authenticator.verify({ token: code, secret });
    } catch {
      return false;
    }
  }

  async completeEnrolment(
    db: Kysely<Database>,
    userAccountId: string,
    secret: string,
    code: string,
    organisationId: string,
  ): Promise<string[]> {
    if (!this.verifyCode(secret, code)) {
      throw new BadRequestException('Invalid verification code.');
    }

    const encrypted = encryptTotpSecret(secret);
    await db
      .updateTable('user_accounts')
      .set({ mfa_enabled: true, totp_secret_encrypted: encrypted })
      .where('id', '=', userAccountId)
      .execute();

    const plaintextCodes: string[] = [];
    const rows: { organisation_id: string; user_account_id: string; code_hash: string }[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const code = generateNumericRecoveryCode();
      plaintextCodes.push(code);
      rows.push({
        organisation_id: organisationId,
        user_account_id: userAccountId,
        code_hash: hashToken(code),
      });
    }
    await db.insertInto('mfa_recovery_codes').values(rows).execute();

    return plaintextCodes; // Displayed once to the user - never persisted in plaintext.
  }

  async verifyChallenge(
    db: Kysely<Database>,
    userAccountId: string,
    code: string,
  ): Promise<boolean> {
    const user = await db
      .selectFrom('user_accounts')
      .select(['totp_secret_encrypted'])
      .where('id', '=', userAccountId)
      .executeTakeFirst();
    if (!user?.totp_secret_encrypted) return false;
    const secret = decryptTotpSecret(user.totp_secret_encrypted);
    return this.verifyCode(secret, code);
  }

  /**
   * Administrator-assisted MFA reset (Architecture §6, P3 item 33): the
   * lost-device-and-recovery-codes recovery path. Strips the user's
   * enrolled TOTP secret and every recovery code, so their next login
   * requires fresh MFA enrolment rather than a challenge - it does NOT
   * re-enrol MFA on their behalf (only the user themselves can do that,
   * since it requires proving possession of a new authenticator). This is
   * a deliberately blunt, fully-reversible-by-re-enrolment action; the
   * caller (the controller) is responsible for requiring the elevated
   * `core.users.mfa_reset` permission and writing the audit event - this
   * method itself has no permission/audit concerns, matching how every
   * other Core service is written (the HTTP layer owns authorisation and
   * audit, services own the safe data operation, Architecture's "no second
   * authorisation universe").
   */
  async adminResetMfa(db: Kysely<Database>, userAccountId: string): Promise<void> {
    await db
      .updateTable('user_accounts')
      .set({ mfa_enabled: false, totp_secret_encrypted: null })
      .where('id', '=', userAccountId)
      .execute();
    await db.deleteFrom('mfa_recovery_codes').where('user_account_id', '=', userAccountId).execute();
  }

  /**
   * TOTP master key rotation pass (P3 item 7 / Architecture §6) for ONE
   * organisation's users, run inside that organisation's withOrgContext by
   * the caller - deliberately NOT a cross-org sweep. Reading every user's
   * encrypted secret across every organisation at once would need a
   * BYPASSRLS-equivalent path this codebase has specifically avoided
   * building (see ADR 0005's rejection of that option for background
   * work); a real installation-wide rotation script instead enumerates
   * organisations (an installation-level, not organisation-scoped, list -
   * see AppModule bootstrap) and calls this once per org, same as any
   * other per-org operational task.
   *
   * Only re-wraps the data key for envelope-format secrets still on
   * TOTP_MASTER_KEY_PREVIOUS; returns how many were rotated, how many were
   * skipped (already current, or a legacy pre-envelope secret not eligible
   * for this mechanism - see totp-encryption.ts's doc comment), and how
   * many genuinely FAILED (opened under neither configured key - e.g. a
   * secret wrapped under a key from before an even earlier rotation that
   * TOTP_MASTER_KEY_PREVIOUS no longer holds). A single unrotatable row
   * does not abort the whole pass - every other user's rotation still
   * proceeds; failures are returned by user id so an operator can
   * investigate them individually rather than the entire operation
   * silently doing nothing because of one bad row.
   */
  async rotateAllMasterKeys(
    db: Kysely<Database>,
  ): Promise<{ rotated: number; skipped: number; failed: Array<{ userAccountId: string; reason: string }> }> {
    const rows = await db
      .selectFrom('user_accounts')
      .select(['id', 'totp_secret_encrypted'])
      .where('totp_secret_encrypted', 'is not', null)
      .execute();

    let rotated = 0;
    let skipped = 0;
    const failed: Array<{ userAccountId: string; reason: string }> = [];
    for (const row of rows) {
      if (!row.totp_secret_encrypted) continue;
      let outcome: { value: string; changed: boolean };
      try {
        outcome = rotateMasterKeyWrapping(row.totp_secret_encrypted);
      } catch (err) {
        failed.push({ userAccountId: row.id, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (outcome.changed) {
        await db
          .updateTable('user_accounts')
          .set({ totp_secret_encrypted: outcome.value })
          .where('id', '=', row.id)
          .execute();
        rotated++;
      } else {
        skipped++;
      }
    }
    return { rotated, skipped, failed };
  }

  /** One-time recovery code use - consumes it so it cannot be reused. */
  async consumeRecoveryCode(
    db: Kysely<Database>,
    userAccountId: string,
    code: string,
  ): Promise<boolean> {
    const codeHash = hashToken(code);
    const row = await db
      .updateTable('mfa_recovery_codes')
      .set({ used_at: new Date() })
      .where('user_account_id', '=', userAccountId)
      .where('code_hash', '=', codeHash)
      .where('used_at', 'is', null)
      .returningAll()
      .executeTakeFirst();
    return !!row;
  }
}
