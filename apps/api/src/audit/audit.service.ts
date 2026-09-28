import { Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { Database } from '../db/types';

export type AuditEventType =
  | 'auth.login.success'
  | 'auth.login.failed'
  | 'auth.logout'
  | 'auth.account.activated'
  | 'auth.account.deactivated'
  | 'rbac.role.changed'
  | 'rbac.user_role.changed'
  | 'config.changed'
  | 'bootstrap.completed'
  | 'auth.mfa.enrolled'
  | 'auth.mfa.recovery_code_used'
  | 'auth.mfa.admin_reset'
  | 'auth.rate_limited'
  | 'app.activated'
  | 'app.licence_imported';

export interface AuditEventInput {
  organisationId: string;
  eventType: AuditEventType;
  actorUserAccountId?: string | null;
  entityType?: string | null;
  entityRef?: string | null;
  /** Structured, non-sensitive metadata only - never secrets/passwords/tokens. */
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
}

const FORBIDDEN_METADATA_KEYS = /password|secret|token|totp|hash/i;

/**
 * Audit framework. P0 item 21. Always called from inside an existing
 * withOrgContext transaction (it is passed the live `db` handle), so an
 * audit row and the mutation it describes commit or roll back together.
 */
@Injectable()
export class AuditService {
  async record(db: Kysely<Database>, input: AuditEventInput): Promise<void> {
    const metadata = this.sanitizeMetadata(input.metadata);
    await db
      .insertInto('audit_events')
      .values({
        organisation_id: input.organisationId,
        event_type: input.eventType,
        actor_user_account_id: input.actorUserAccountId ?? null,
        entity_type: input.entityType ?? null,
        entity_ref: input.entityRef ?? null,
        metadata: metadata as any,
        correlation_id: input.correlationId ?? null,
      })
      .execute();
  }

  private sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
    if (!metadata) return {};
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (FORBIDDEN_METADATA_KEYS.test(key)) {
        throw new Error(
          `AuditService: refusing to write metadata key "${key}" - looks like a secret. ` +
            'Audit rows must never contain secrets/passwords/tokens.',
        );
      }
      safe[key] = value;
    }
    return safe;
  }
}
