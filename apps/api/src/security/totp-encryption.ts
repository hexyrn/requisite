import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * TOTP secret encryption at rest - P0 simplified scheme.
 *
 * Architecture §6 specifies full envelope encryption (a per-installation
 * master key wraps per-secret data keys, so master-key rotation re-wraps
 * data keys without re-issuing enrolments). P0 implements AES-256-GCM
 * directly with a single master key read from TOTP_MASTER_KEY - this is a
 * DOCUMENTED, DELIBERATE simplification, not a silent shortcut:
 *
 *   - Full envelope encryption (per-secret data keys wrapped by the master
 *     key, enabling rotation without re-enrolment) is deferred to a
 *     post-P0 follow-up and tracked as technical debt - see the final P0
 *     report / docs/decisions.
 *   - Today, rotating TOTP_MASTER_KEY invalidates all stored TOTP secrets
 *     (they cannot be decrypted with the new key) and requires every user
 *     to re-enrol MFA. This is an accepted P0 limitation.
 */
const ALGO = 'aes-256-gcm';

function getMasterKey(): Buffer {
  const raw = process.env.TOTP_MASTER_KEY;
  if (!raw) {
    throw new Error('TOTP_MASTER_KEY is not set');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('TOTP_MASTER_KEY must decode to exactly 32 bytes (base64-encoded)');
  }
  return key;
}

export function encryptTotpSecret(plainSecret: string): string {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptTotpSecret(stored: string): string {
  const key = getMasterKey();
  const [ivB64, tagB64, ctB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new Error('Malformed encrypted TOTP secret');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}
