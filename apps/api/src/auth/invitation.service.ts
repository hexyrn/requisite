import { Injectable, BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../db/types';
import { generateSecureToken, hashToken } from '../security/tokens';
import { hashPassword } from '../security/passwords';

const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface CreateInvitationResult {
  invitationId: string;
  /** Present only when SMTP isn't configured - admin surfaces this URL manually. P0 item 15. */
  invitationUrlForAdmin?: string;
}

/** Single-use, expiring, hashed invitation tokens; invited user sets their own password. P0 item 15. */
@Injectable()
export class InvitationService {
  async createInvitation(
    db: Kysely<Database>,
    organisationId: string,
    invitedByUserAccountId: string,
    email: string,
    roleIds: string[],
    smtpConfigured: boolean,
    baseUrl: string,
  ): Promise<CreateInvitationResult> {
    const plaintextToken = generateSecureToken(32);
    const invitation = await db
      .insertInto('invitations')
      .values({
        organisation_id: organisationId,
        email,
        token_hash: hashToken(plaintextToken),
        invited_by_user_account_id: invitedByUserAccountId,
        role_ids: roleIds as any,
        expires_at: new Date(Date.now() + INVITATION_TTL_MS),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (smtpConfigured) {
      // Delivery is out of P0 scope (notifications is P1) - a real deployment
      // would send this via the configured SMTP provider here.
      return { invitationId: invitation.id };
    }

    // SMTP not configured: never fail the invitation - expose the URL to the admin instead.
    return {
      invitationId: invitation.id,
      invitationUrlForAdmin: `${baseUrl}/setup/accept-invitation?token=${plaintextToken}`,
    };
  }

  async acceptInvitation(
    db: Kysely<Database>,
    organisationId: string,
    plaintextToken: string,
    password: string,
  ): Promise<{ userAccountId: string }> {
    const tokenHash = hashToken(plaintextToken);
    const invitation = await db
      .updateTable('invitations')
      .set({ accepted_at: new Date() })
      .where('organisation_id', '=', organisationId)
      .where('token_hash', '=', tokenHash)
      .where('accepted_at', 'is', null)
      .where('expires_at', '>', new Date())
      .returningAll()
      .executeTakeFirst();

    if (!invitation) {
      throw new BadRequestException('Invitation is invalid, already accepted, or expired.');
    }

    const passwordHash = await hashPassword(password);
    const user = await db
      .insertInto('user_accounts')
      .values({
        organisation_id: organisationId,
        email: invitation.email,
        password_hash: passwordHash,
        is_active: true,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    if (invitation.role_ids && invitation.role_ids.length > 0) {
      await db
        .insertInto('user_roles')
        .values(
          invitation.role_ids.map((roleId) => ({
            organisation_id: organisationId,
            user_account_id: user.id,
            role_id: roleId,
          })),
        )
        .execute();
    }

    return { userAccountId: user.id };
  }
}
