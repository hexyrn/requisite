import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { generateSecureToken, hashToken } from '../../security/tokens';
import { encryptSecret, decryptSecret } from '../../security/secret-encryption';

export interface RegisteredWebhookEndpoint {
  id: string;
  /** The plaintext signing key - shown to the caller exactly once, never stored, never retrievable again. */
  signingKey: string;
}

/**
 * Webhook endpoint registration and outbound HMAC signing. P2 item 14.
 * Each endpoint gets a fresh signing key at registration time: a hash of it
 * is stored (secret_hash) purely so a caller can later re-confirm "is this
 * the key you gave me" without Core ever showing it again, and an
 * AES-256-GCM ENCRYPTED copy (signing_key_encrypted) is stored separately
 * because, unlike a password/API-secret, the plaintext key must be
 * recoverable later - it is needed every single delivery to compute the
 * HMAC signature the receiving endpoint verifies against.
 */
@Injectable()
export class WebhookService {
  async registerEndpoint(db: Kysely<Database>, organisationId: string, url: string, eventTypes: string[], description?: string, createdBy?: string): Promise<RegisteredWebhookEndpoint> {
    if (!/^https:\/\//.test(url)) {
      // P2 item 24 - refuse to register a plaintext-HTTP destination for a signed secret delivery.
      throw new Error('Webhook endpoint URL must use https://');
    }
    const signingKey = generateSecureToken(32);
    const row = await db
      .insertInto('webhook_endpoints')
      .values({
        organisation_id: organisationId,
        url,
        description: description ?? null,
        event_types: eventTypes,
        secret_hash: hashToken(signingKey),
        signing_key_encrypted: encryptSecret(signingKey),
        created_by: createdBy ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return { id: row.id, signingKey };
  }

  async disableEndpoint(db: Kysely<Database>, organisationId: string, endpointId: string): Promise<void> {
    await db.updateTable('webhook_endpoints').set({ is_enabled: false }).where('id', '=', endpointId).where('organisation_id', '=', organisationId).execute();
  }

  /** Computes the delivery signature exactly as a receiver is expected to re-derive it: HMAC-SHA256 over the raw JSON body, hex-encoded, prefixed `sha256=`. */
  sign(payload: string, signingKey: string): string {
    return `sha256=${createHmac('sha256', signingKey).update(payload).digest('hex')}`;
  }

  /** Constant-time verification helper, exposed for the reference connector / any consumer that needs to verify an inbound Hexyrn webhook. */
  verifySignature(payload: string, signingKey: string, providedSignature: string): boolean {
    const expected = Buffer.from(this.sign(payload, signingKey));
    const provided = Buffer.from(providedSignature);
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  decryptSigningKey(encrypted: string): string {
    return decryptSecret(encrypted);
  }
}
