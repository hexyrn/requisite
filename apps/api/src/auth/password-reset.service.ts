import { Injectable, BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../db/types';
import { generateSecureToken, hashToken } from '../security/tokens';
import { hashPassword } from '../security/passwords';
import { SessionService } from '../sessions/session.service';

const RESET_TOKEN_TTL_MS = 1000 * 60 * 60; // 1 hour

/** Single-use, expiring, hashed password reset tokens. P0 item 14. */
@Injectable()
export class PasswordResetService {
  constructor(private readonly sessions: SessionService) {}

  async requestReset(db: Kysely<Database>, organisationId: string, userAccountId: string): Promise<string> {
    const plaintextToken = generateSecureToken(32);
    await db
      .insertInto('password_reset_tokens')
      .values({
        organisation_id: organisationId,
        user_account_id: userAccountId,
        token_hash: hashToken(plaintextToken),
        expires_at: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      })
      .execute();
    // Caller is responsible for delivery (email) - we never email the password itself,
    // only this single-use link/token.
    return plaintextToken;
  }

  async completeReset(
    db: Kysely<Database>,
    organisationId: string,
    plaintextToken: string,
    newPassword: string,
  ): Promise<void> {
    const tokenHash = hashToken(plaintextToken);
    const row = await db
      .updateTable('password_reset_tokens')
      .set({ used_at: new Date() })
      .where('organisation_id', '=', organisationId)
      .where('token_hash', '=', tokenHash)
      .where('used_at', 'is', null)
      .where('expires_at', '>', new Date())
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      throw new BadRequestException('Password reset token is invalid, already used, or expired.');
    }

    const passwordHash = await hashPassword(newPassword);
    await db
      .updateTable('user_accounts')
      .set({ password_hash: passwordHash })
      .where('id', '=', row.user_account_id)
      .execute();

    // Global revocation ("log out everywhere") on password reset, per Architecture §6.
    await this.sessions.revokeAllSessionsForUser(db, row.user_account_id);
  }
}
