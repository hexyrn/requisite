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
 * - This shipped file contains NO private key of any kind. The matching
 *   throw-away TEST private key used by the automated tests lives in
 *   src/vendor-tools/licensing/test-keys.ts, which is excluded from the
 *   compiled application (tsconfig.json), as is all signing code.
 * - The public test key below is a DEV/TEST key ONLY. Outside production,
 *   when HEXYRN_LICENSE_PUBLIC_KEY is unset, the server falls back to it
 *   with a loud structured warning so development and CI work without
 *   configuration. In PRODUCTION the fallback is refused outright
 *   (getConfiguredPublicKey throws), in addition to the startup guard in
 *   config/production-config-check.ts: a customer installation can only
 *   ever trust the key Hexyrn's installer was built with.
 */
import { logStructured } from '../../logging/logger';

// Public half of the repository's throw-away test keypair (see the note above).
export const TEST_LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAF9DxmucM/+RCqbVS1vVoLriDczp7Y58T7D5qooXmdjU=
-----END PUBLIC KEY-----`;

/**
 * Accepts the public key however an operator can realistically get it into an
 * environment variable: a real multi-line PEM, a PEM with literal "\\n"
 * sequences (single-line .env / Docker / systemd), or just the bare base64
 * body that `licence-tool keygen` prints. Node's crypto only understands a
 * properly line-broken PEM, so anything else is normalised to one.
 */
export function normalizePublicKeyPem(raw: string): string {
  let value = raw
    .trim()
    .replace(/^(["'])(.*)\1$/s, '$2')
    .replace(/\\n/g, '\n')
    .trim();
  if (!value.includes('BEGIN')) {
    const body = value.replace(/\s+/g, '');
    const lines = body.match(/.{1,64}/g) ?? [];
    value = `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
  }
  return value;
}

export function getConfiguredPublicKey(): string {
  const configured = process.env.HEXYRN_LICENSE_PUBLIC_KEY;
  if (configured && configured.trim().length > 0) {
    return normalizePublicKeyPem(configured);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'HEXYRN_LICENSE_PUBLIC_KEY is not set. Refusing to verify licences against the built-in test key in production.',
    );
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
