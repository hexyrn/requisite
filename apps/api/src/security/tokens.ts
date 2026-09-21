import { randomBytes, createHash, timingSafeEqual } from 'crypto';

/** Cryptographically secure, URL-safe random token (bootstrap, password reset, invitations). */
export function generateSecureToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are already high-entropy random values (256 bits by default), so a
 * fast SHA-256 hash (not Argon2id) is the accepted pattern for at-rest
 * storage of single-use tokens - unlike passwords, there is no meaningful
 * offline-guessing risk to defend against with a slow hash, since the token
 * space is not guessable. Passwords use Argon2id (see passwords.ts).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function verifyTokenHash(token: string, hash: string): boolean {
  const candidate = Buffer.from(hashToken(token));
  const expected = Buffer.from(hash);
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

export function generateNumericRecoveryCode(): string {
  // 10-digit recovery code, grouped for readability by the caller.
  const n = randomBytes(5).readUIntBE(0, 5) % 10_000_000_000;
  return n.toString().padStart(10, '0');
}
