/**
 * License signing/verification key material. P2 item 21 - resolves
 * ADR 0004's stub with genuine Ed25519 signature verification.
 *
 * PRODUCTION KEY HANDLING (read this before touching this file):
 * - The Hexyrn commercial PRIVATE signing key must NEVER be committed to
 *   this repository, ever, under any circumstances. It lives only in
 *   Hexyrn's own offline license-generation environment.
 * - Core ships only the PUBLIC verification key, read from the
 *   `HEXYRN_LICENSE_PUBLIC_KEY` environment variable (PEM, SPKI format).
 *   Verification is pure local cryptography - no network call is ever
 *   made to check a license (see LicenseVerifier), so "no mandatory
 *   online activation" and "works with no network connectivity" hold
 *   structurally, not just by policy.
 * - The keypair below is a DEV/TEST keypair ONLY, generated specifically
 *   for this repository's own test suite and the reference app. It is
 *   unmistakably not the production key: it is committed in full
 *   (including the "private" half, which a real production key never
 *   would be), it is labelled TEST_ at every use site, and
 *   `getConfiguredPublicKey()` logs a loud structured warning whenever it
 *   falls back to this key instead of a configured
 *   `HEXYRN_LICENSE_PUBLIC_KEY`. A production deployment that never sets
 *   that environment variable would verify licenses against this well-
 *   known, publicly-committed test key - which is exactly why the warning
 *   exists: this must never happen silently.
 */
import { logStructured } from '../../logging/logger';

// Generated once via `crypto.generateKeyPairSync('ed25519')` for this
// repository's tests and the reference app/connector only.
export const TEST_LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAF9DxmucM/+RCqbVS1vVoLriDczp7Y58T7D5qooXmdjU=
-----END PUBLIC KEY-----`;

export const TEST_LICENSE_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIEE5oImvlwDwKH6vyjNw4QIebzvBYWVWwjJIdLnQHZca
-----END PRIVATE KEY-----`;

export function getConfiguredPublicKey(): string {
  const configured = process.env.HEXYRN_LICENSE_PUBLIC_KEY;
  if (configured && configured.trim().length > 0) {
    return configured;
  }
  logStructured({
    event: 'licensing.using_test_public_key',
    errorCode: 'NO_LICENSE_PUBLIC_KEY_CONFIGURED',
    context: {
      message:
        'HEXYRN_LICENSE_PUBLIC_KEY is not set - falling back to the publicly-committed TEST key. ' +
        'Any license signed with the matching (also publicly committed) test private key will verify successfully. ' +
        'This is expected in development/CI, but a production deployment MUST set HEXYRN_LICENSE_PUBLIC_KEY to the real Hexyrn public key.',
    },
  });
  return TEST_LICENSE_PUBLIC_KEY_PEM;
}
