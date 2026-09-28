import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * General-purpose secret-at-rest encryption, same accepted P0/P1 pattern as
 * totp-encryption.ts (AES-256-GCM with a single master key from an env var
 * - full envelope encryption/rotation is the same documented deferred
 * follow-up as ADR 0002). Used for P2 secrets that must be stored
 * encrypted-not-hashed because the plaintext must be recoverable at
 * delivery/sync time (webhook signing keys, integration connection
 * config_secrets) - unlike passwords/API credentials, which are
 * one-way-hashed because the plaintext is never needed again after issuance.
 */
const ALGO = 'aes-256-gcm';

function getMasterKey(): Buffer {
  const raw = process.env.SECRET_ENCRYPTION_MASTER_KEY ?? process.env.TOTP_MASTER_KEY;
  if (!raw) {
    throw new Error('SECRET_ENCRYPTION_MASTER_KEY is not set');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      'SECRET_ENCRYPTION_MASTER_KEY must decode to exactly 32 bytes (base64-encoded)',
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    '.',
  );
}

export function decryptSecret(stored: string): string {
  const key = getMasterKey();
  const [ivB64, tagB64, ctB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error('Malformed encrypted secret');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

/** Encrypts every string value of a flat secrets object; non-string values are JSON-stringified first. */
export function encryptSecretsMap(secrets: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
    out[key] = encryptSecret(plaintext);
  }
  return out;
}

export function decryptSecretsMap(encrypted: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(encrypted)) {
    out[key] = decryptSecret(value);
  }
  return out;
}
