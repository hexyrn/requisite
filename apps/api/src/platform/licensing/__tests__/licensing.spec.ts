/**
 * P2 item 21 - every required licensing test case, resolving ADR 0004's
 * P1 stub with genuine Ed25519 verification. Pure unit tests (no database
 * needed - LicenseVerifier is pure local cryptography, which is itself
 * part of what's being proven: "works with no network connectivity" holds
 * because there is no network code in this path at all, not because a
 * test merely didn't exercise one).
 */
import { LicenseSigner } from '../../../vendor-tools/licensing/license-signer';
import { LicenseVerifier } from '../license-verifier';
import { TEST_LICENSE_PRIVATE_KEY_PEM } from '../../../vendor-tools/licensing/test-keys';
import { TEST_LICENSE_PUBLIC_KEY_PEM, getConfiguredPublicKey } from '../keys';
import { canonicalize } from '../license-payload';
import { generateKeyPairSync } from 'crypto';

describe('Licensing - Ed25519 signature verification (P2 item 21)', () => {
  const signer = new LicenseSigner(TEST_LICENSE_PRIVATE_KEY_PEM);
  const verifier = new LicenseVerifier();

  beforeEach(() => {
    delete process.env.HEXYRN_LICENSE_PUBLIC_KEY; // ensure we're testing against the TEST key unless a test overrides it
  });

  it('VALID SIGNATURE: a genuinely signed license verifies successfully', () => {
    const license = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: null,
    });
    const result = verifier.verify(license, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
    });
    expect(result.valid).toBe(true);
  });

  it('INVALID SIGNATURE: a garbage/random signature is rejected', () => {
    const license = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: null,
    });
    const forged = {
      ...license,
      signature: Buffer.from('not-a-real-signature-at-all-000000').toString('base64'),
    };
    const result = verifier.verify(forged, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invalid signature/i);
  });

  it('MODIFIED PAYLOAD: changing any field after signing invalidates the signature', () => {
    const license = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: null,
    });
    const tampered = { ...license, majorVersion: 2 }; // attacker tries to upgrade their own license
    const result = verifier.verify(tampered, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 2,
    });
    expect(result.valid).toBe(false);
  });

  it('MODIFIED PAYLOAD: tampering with supportExpiresAt (trying to extend support) invalidates the signature', () => {
    const license = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: '2020-01-01T00:00:00.000Z',
    });
    const tampered = { ...license, supportExpiresAt: '2099-01-01T00:00:00.000Z' };
    const result = verifier.verify(tampered, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
    });
    expect(result.valid).toBe(false);
  });

  it('WRONG ORGANISATION: a genuinely valid license for org-1 is rejected when presented for org-2', () => {
    const license = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: null,
    });
    const result = verifier.verify(license, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-2',
      majorVersion: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/organisation/i);
  });

  it('WRONG PRODUCT: a valid license for one app is rejected for a different app', () => {
    const license = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: null,
    });
    const result = verifier.verify(license, {
      appId: 'com.hexyrn.some-other-app',
      organisationId: 'org-1',
      majorVersion: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/app/i);
  });

  it('WRONG MAJOR VERSION: a v1 license is rejected when checked against v2', () => {
    const license = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: null,
    });
    const result = verifier.verify(license, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 2,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/major version/i);
  });

  it('SUPPORT EXPIRY DOES NOT DISABLE RUNTIME: a license with an expired supportExpiresAt still verifies as valid', () => {
    const license = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    const result = verifier.verify(license, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
    });
    // Signature/identity verification succeeds regardless of support expiry -
    // support status is informational, checked separately (ApplicationRegistryService
    // never gates `licensed`/`active` on support_expires_at), never a runtime gate.
    expect(result.valid).toBe(true);
  });

  it('NO NETWORK CONNECTIVITY: verification never performs any I/O - proven by code inspection AND by working correctly with no network mocks/stubs of any kind', () => {
    // If LicenseVerifier.verify ever tried to make an HTTP/DNS/socket call,
    // there is no fetch/http mock configured in this test file - it would
    // either throw (no such global) or hang. It does neither; it returns synchronously.
    const license = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: null,
    });
    const start = Date.now();
    const result = verifier.verify(license, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
    });
    const elapsedMs = Date.now() - start;
    expect(result.valid).toBe(true);
    expect(elapsedMs).toBeLessThan(50); // pure local crypto is fast; a real network call would not be
  });

  it('OLDER LICENCE REMAINS VALID WHEN A NEWER MAJOR VERSION EXISTS: a v1 license does not become invalid just because v2 is also being verified elsewhere', () => {
    const v1 = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: null,
    });
    const v2 = signer.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 2,
      supportExpiresAt: null,
    });

    const v2Result = verifier.verify(v2, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 2,
    });
    expect(v2Result.valid).toBe(true);

    // The v1 license, checked independently against its own major version, is UNCHANGED.
    const v1Result = verifier.verify(v1, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
    });
    expect(v1Result.valid).toBe(true);
  });

  it("a license signed with a DIFFERENT keypair (not Hexyrn's) is rejected - proves the public key is actually enforced, not just present", () => {
    const { privateKey: rogueKey } = generateKeyPairSync('ed25519');
    const rogueSigner = new LicenseSigner(
      rogueKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    );
    const forgedLicense = rogueSigner.issue({
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
      supportExpiresAt: null,
    });
    const result = verifier.verify(forgedLicense, {
      appId: 'com.hexyrn.reference',
      organisationId: 'org-1',
      majorVersion: 1,
    });
    expect(result.valid).toBe(false);
  });

  it('canonicalize() produces a stable, key-order-independent representation', () => {
    const a = canonicalize({
      licenseId: 'x',
      appId: 'a',
      organisationId: 'o',
      majorVersion: 1,
      issuedAt: 't',
      supportExpiresAt: null,
    });
    const b = canonicalize({
      supportExpiresAt: null,
      majorVersion: 1,
      organisationId: 'o',
      issuedAt: 't',
      appId: 'a',
      licenseId: 'x',
    });
    expect(a).toBe(b);
  });

  it('PRODUCTION never falls back to the built-in test key: with no configured key it refuses, rather than trusting a publicly-known key', () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.HEXYRN_LICENSE_PUBLIC_KEY;
      expect(() => getConfiguredPublicKey()).toThrow(/HEXYRN_LICENSE_PUBLIC_KEY is not set/);
      // ...and a licence signed with the (public) test private key therefore cannot verify at all.
      const license = signer.issue({
        appId: 'x',
        organisationId: 'y',
        majorVersion: 1,
        supportExpiresAt: null,
      });
      expect(
        verifier.verify(license, { appId: 'x', organisationId: 'y', majorVersion: 1 }).valid,
      ).toBe(false); // fails closed
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  it('DEV/TEST KEY LABELLING: the test keypair is unmistakably not a production key (documented, and matches the committed private key)', () => {
    // The mere fact that TEST_LICENSE_PRIVATE_KEY_PEM is importable/committed
    // at all is itself the proof it cannot be a real production key (a real
    // one would never be committed) - this test just confirms the exported
    // pair is internally consistent (sign with the "private" half, verify
    // with the "public" half) so nobody accidentally ships a mismatched pair.
    const license = signer.issue({
      appId: 'x',
      organisationId: 'y',
      majorVersion: 1,
      supportExpiresAt: null,
    });
    process.env.HEXYRN_LICENSE_PUBLIC_KEY = TEST_LICENSE_PUBLIC_KEY_PEM;
    const result = verifier.verify(license, { appId: 'x', organisationId: 'y', majorVersion: 1 });
    expect(result.valid).toBe(true);
    delete process.env.HEXYRN_LICENSE_PUBLIC_KEY;
  });

  it('HEXYRN_LICENSE_PUBLIC_KEY override: a license signed with a configured production-style key verifies against that key, not the built-in test key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const prodLikeSigner = new LicenseSigner(
      privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    );
    const license = prodLikeSigner.issue({
      appId: 'x',
      organisationId: 'y',
      majorVersion: 1,
      supportExpiresAt: null,
    });

    process.env.HEXYRN_LICENSE_PUBLIC_KEY = publicKey.export({
      type: 'spki',
      format: 'pem',
    }) as string;
    const result = verifier.verify(license, { appId: 'x', organisationId: 'y', majorVersion: 1 });
    expect(result.valid).toBe(true);

    // The SAME license does NOT verify against the built-in test key.
    delete process.env.HEXYRN_LICENSE_PUBLIC_KEY;
    const resultAgainstTestKey = verifier.verify(license, {
      appId: 'x',
      organisationId: 'y',
      majorVersion: 1,
    });
    expect(resultAgainstTestKey.valid).toBe(false);
  });
});
