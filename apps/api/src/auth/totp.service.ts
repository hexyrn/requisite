import { Injectable, BadRequestException } from '@nestjs/common';
import { authenticator } from 'otplib';
import { Kysely } from 'kysely';
import { Database } from '../db/types';
import { encryptTotpSecret, decryptTotpSecret } from '../security/totp-encryption';
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
