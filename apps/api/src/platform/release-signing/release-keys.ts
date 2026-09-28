/**
 * Release-signing key material. P3 items 16/26/27 (release manifest
 * signing + key rotation). DELIBERATELY A SEPARATE MODULE from
 * platform/licensing/keys.ts - release signing and licence signing must
 * not share private keys merely because both use Ed25519 (explicit
 * instruction). A compromise of one signing domain must never let an
 * attacker forge material in the other.
 *
 * PRODUCTION OPERATIONAL REQUIREMENT (read this before touching this file):
 * Hexyrn's production release-signing private key must be generated and
 * retained OUTSIDE this source repository and outside customer software,
 * using appropriately secured Hexyrn-controlled key storage (the specific
 * mechanism - HSM, cloud KMS, offline air-gapped signing machine, etc. - is
 * a pre-GA operational decision, not made here; see
 * docs/RELEASE_SIGNING.md). Only PUBLIC verification keys are ever
 * distributed to installations, via HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS
 * (below) - never a private key, never via this file for production use.
 *
 * The two keypairs below are DEV/TEST keys ONLY, generated specifically
 * for this repository's own tests and the reference release-signing tool.
 * Unmistakably not production keys: both halves are committed (a real
 * production private key never would be), every export is labelled TEST_,
 * and getTrustedReleasePublicKeys() logs a loud structured warning whenever
 * it falls back to these instead of a configured
 * HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS. Two keys are committed (not one) so
 * the SAME rotation mechanism used in production (a set of trusted keys,
 * keyed by id, old ones remaining valid for historical material) is
 * exercised by real tests against real Ed25519 keys, not mocked.
 */
import { logStructured } from '../../logging/logger';

export const TEST_RELEASE_KEY_ID_1 = 'test-release-key-1';
export const TEST_RELEASE_PUBLIC_KEY_1_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9czJIfQzVwlT7QLI2dbvxC0sLaLiZ9bPvq9w00guc7o=
-----END PUBLIC KEY-----`;
export const TEST_RELEASE_PRIVATE_KEY_1_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIPX27uWNdwQXWj/pUcKG35p3HloYmUn5fgn6NHKrrHuM
-----END PRIVATE KEY-----`;

export const TEST_RELEASE_KEY_ID_2 = 'test-release-key-2';
export const TEST_RELEASE_PUBLIC_KEY_2_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEACi1+8aemlPnUXxzgXDjUXFmSk3vkYXSbr0MWW2zEWcY=
-----END PUBLIC KEY-----`;
export const TEST_RELEASE_PRIVATE_KEY_2_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIL/CX7MbqNrH0MU+w3/00LY5f7jVGxvdZZj0kPutYpTk
-----END PRIVATE KEY-----`;

export interface TrustedKeyEntry {
  keyId: string;
  publicKeyPem: string;
  /** 'current' = new releases are expected to use this key; 'historical' = still trusted for verifying old releases, but new signing shouldn't use it. Neither implies anything about verification - both verify successfully; this is purely informational/for tooling. */
  status: 'current' | 'historical';
}

/**
 * The trust set: every public key this installation currently accepts a
 * release signature from, keyed by key id. Configured via
 * HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS as a JSON array of
 * {keyId, publicKeyPem, status}. Falls back to the committed dev/test pair
 * (with a loud warning) if unset - same pattern as licensing/keys.ts, so a
 * production deployment that forgets to configure this is never silently
 * trusting a well-known test key.
 */
export function getTrustedReleasePublicKeys(): TrustedKeyEntry[] {
  const configured = process.env.HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS;
  if (configured && configured.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configured);
    } catch (err) {
      throw new Error(
        `HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS is set but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error(
        'HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS must be a non-empty JSON array of {keyId, publicKeyPem, status}.',
      );
    }
    return parsed as TrustedKeyEntry[];
  }

  logStructured({
    event: 'release_signing.using_test_public_keys',
    errorCode: 'NO_RELEASE_TRUSTED_KEYS_CONFIGURED',
    context: {
      message:
        'HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS is not set - falling back to the publicly-committed TEST release-signing keys. ' +
        'Any release manifest signed with a matching (also publicly committed) test private key will verify successfully. ' +
        'This is expected in development/CI, but a production deployment MUST set HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS to the real Hexyrn release-signing public key(s).',
    },
  });
  return [
    {
      keyId: TEST_RELEASE_KEY_ID_1,
      publicKeyPem: TEST_RELEASE_PUBLIC_KEY_1_PEM,
      status: 'current',
    },
    {
      keyId: TEST_RELEASE_KEY_ID_2,
      publicKeyPem: TEST_RELEASE_PUBLIC_KEY_2_PEM,
      status: 'historical',
    },
  ];
}
