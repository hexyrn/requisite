import { InstallationService } from './installation.service';
import { Injectable, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { getPool } from '../db/pool';
import { withOrgContext } from '../db/org-context';
import { hashToken } from '../security/tokens';
import { hashPassword } from '../security/passwords';
import { AuditService } from '../audit/audit.service';
import { ALL_CORE_PERMISSIONS } from '../rbac/permissions';
import { CompleteBootstrapDto } from './dto';

export type CompleteBootstrapInput = CompleteBootstrapDto;

export interface CompleteBootstrapResult {
  organisationId: string;
  ownerUserAccountId: string;
}

@Injectable()
export class BootstrapService {
  constructor(private readonly audit: AuditService) {}

  /**
   * One-time protected setup flow. P0 item 6.
   *
   * The bootstrap token is validated and consumed inside the SAME
   * transaction that creates the organisation/owner - so a token cannot be
   * raced/reused even under concurrent requests (the UPDATE ... WHERE
   * consumed_at IS NULL below only ever succeeds for exactly one caller;
   * the unique row lock inherent in UPDATE makes a second concurrent caller
   * either wait and then find 0 rows updated, or find 0 rows updated
   * immediately).
   */
  async completeBootstrap(
    input: CompleteBootstrapInput,
    pool: Pool = getPool(),
  ): Promise<CompleteBootstrapResult> {
    const organisationId = randomUUID();
    const tokenHash = hashToken(input.token);

    const result = await withOrgContext(
      organisationId,
      async (db) => {
        // Consume the token atomically: only succeeds once, ever.
        const consumed = await db
          .updateTable('bootstrap_tokens')
          .set({ consumed_at: new Date() })
          .where('token_hash', '=', tokenHash)
          .where('consumed_at', 'is', null)
          .returningAll()
          .executeTakeFirst();

        if (!consumed) {
          throw new BadRequestException('Bootstrap token is invalid, already used, or expired.');
        }

        const organisation = await db
          .insertInto('organisations')
          .values({
            id: organisationId,
            installation_id: consumed.installation_id,
            name: input.organisationName,
            display_name: input.organisationDisplayName,
            default_currency: input.defaultCurrency,
            timezone: input.timezone,
            locale: input.locale,
            financial_year_start_month: input.financialYearStartMonth,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const passwordHash = await hashPassword(input.ownerPassword);
        const owner = await db
          .insertInto('user_accounts')
          .values({
            organisation_id: organisation.id,
            email: input.ownerEmail,
            password_hash: passwordHash,
            is_active: true,
            is_owner: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        const ownerRole = await db
          .insertInto('roles')
          .values({ organisation_id: organisation.id, name: 'Owner', is_system_role: true })
          .returningAll()
          .executeTakeFirstOrThrow();

        if (ALL_CORE_PERMISSIONS.length > 0) {
          await db
            .insertInto('role_permissions')
            .values(
              ALL_CORE_PERMISSIONS.map((permission_key) => ({
                organisation_id: organisation.id,
                role_id: ownerRole.id,
                permission_key,
              })),
            )
            .execute();
        }

        await db
          .insertInto('user_roles')
          .values({
            organisation_id: organisation.id,
            user_account_id: owner.id,
            role_id: ownerRole.id,
          })
          .execute();

        await this.audit.record(db, {
          organisationId: organisation.id,
          eventType: 'bootstrap.completed',
          actorUserAccountId: owner.id,
          entityType: 'organisation',
          entityRef: organisation.id,
        });

        // installations has no RLS, so this same connection/transaction can
        // record "which org is this installation's primary org" for v1's
        // single-organisation product behaviour (Architecture §7) - this is
        // how the public login endpoint finds which org to authenticate
        // against without needing org context to already exist.
        await db
          .updateTable('installations')
          .set({ config: { primaryOrganisationId: organisation.id } as any })
          .where('id', '=', consumed.installation_id)
          .execute();

        return { organisationId: organisation.id, ownerUserAccountId: owner.id };
      },
      pool,
    );

    // The token is now dead; don't leave a plaintext copy on disk (best effort, never fails setup).
    new InstallationService().clearTokenFile();
    return result;
  }
}
