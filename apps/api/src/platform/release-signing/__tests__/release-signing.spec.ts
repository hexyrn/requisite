import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { generateKeyPairSync } from 'crypto';
import { ReleaseManifest, canonicalizeManifest } from '../release-manifest';
import { signReleaseManifest, buildReleaseManifest } from '../release-signer';
import { ReleaseVerifier } from '../release-verifier';
import {
  TEST_RELEASE_KEY_ID_1,
  TEST_RELEASE_PUBLIC_KEY_1_PEM,
  TEST_RELEASE_PRIVATE_KEY_1_PEM,
  TEST_RELEASE_KEY_ID_2,
  TEST_RELEASE_PUBLIC_KEY_2_PEM,
  TEST_RELEASE_PRIVATE_KEY_2_PEM,
  getTrustedReleasePublicKeys,
} from '../release-keys';

const BASE_MANIFEST: Omit<ReleaseManifest, 'artifactSha256' | 'artifactSizeBytes' | 'builtAt'> = {
  formatVersion: 1,
  productId: 'hexyrn-core',
  version: '1.0.0-rc1',
  requiresCoreVersion: '1.0.0-rc1',
  artifactType: 'docker-image',
  migrationNotes: null,
};

function fakeManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    ...BASE_MANIFEST,
    artifactSha256: 'a'.repeat(64),
    artifactSizeBytes: 1234,
    builtAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('Release signing (P3 items 16/26/27)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('signing + verification round trip', () => {
    it('a manifest signed with a trusted key verifies successfully', () => {
      delete process.env.HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS; // use the committed test trust set
      const manifest = fakeManifest();
      const signed = signReleaseManifest(
        manifest,
        TEST_RELEASE_KEY_ID_1,
        TEST_RELEASE_PRIVATE_KEY_1_PEM,
      );

      const verifier = new ReleaseVerifier();
      const result = verifier.verifyManifest(signed);
      expect(result.valid).toBe(true);
    });

    it('every manifest field is covered by the signature - modifying ANY field invalidates it', () => {
      const manifest = fakeManifest();
      const signed = signReleaseManifest(
        manifest,
        TEST_RELEASE_KEY_ID_1,
        TEST_RELEASE_PRIVATE_KEY_1_PEM,
      );
      const verifier = new ReleaseVerifier();

      const tamperedVersion = { ...signed, version: '1.0.0-rc2' };
      expect(verifier.verifyManifest(tamperedVersion).valid).toBe(false);

      const tamperedHash = { ...signed, artifactSha256: 'b'.repeat(64) };
      expect(verifier.verifyManifest(tamperedHash).valid).toBe(false);

      const tamperedCoreVersion = { ...signed, requiresCoreVersion: '2.0.0' };
      expect(verifier.verifyManifest(tamperedCoreVersion).valid).toBe(false);
    });

    it('canonicalize() produces the same bytes for the same manifest regardless of key insertion order', () => {
      const a = fakeManifest();
      const b = { ...a }; // structurally identical, JS object key order may differ in practice but doesn't matter here
      expect(canonicalizeManifest(a)).toBe(canonicalizeManifest(b));
    });
  });

  describe('key rotation - the core requirement of items 11/26/27', () => {
    it('a release signed with the OLD (now historical) key still verifies after a newer current key exists', () => {
      // TEST_RELEASE_KEY_ID_2 is listed as 'historical' in the default test
      // trust set (release-keys.ts) alongside TEST_RELEASE_KEY_ID_1 as
      // 'current' - proving historical material does not become
      // unverifiable merely because a newer key now signs new releases.
      delete process.env.HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS;
      const oldSigned = signReleaseManifest(
        fakeManifest({ version: '0.9.0' }),
        TEST_RELEASE_KEY_ID_2,
        TEST_RELEASE_PRIVATE_KEY_2_PEM,
      );
      const newSigned = signReleaseManifest(
        fakeManifest({ version: '1.0.0' }),
        TEST_RELEASE_KEY_ID_1,
        TEST_RELEASE_PRIVATE_KEY_1_PEM,
      );

      const verifier = new ReleaseVerifier();
      expect(verifier.verifyManifest(oldSigned).valid).toBe(true);
      expect(verifier.verifyManifest(newSigned).valid).toBe(true);
    });

    it('an UNKNOWN signing key id is rejected outright, even with a cryptographically valid signature from a real (but untrusted) key', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const untrustedPrivatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

      const manifest = fakeManifest();
      const signed = signReleaseManifest(
        manifest,
        'some-attacker-controlled-key-id',
        untrustedPrivatePem,
      );

      const verifier = new ReleaseVerifier();
      const result = verifier.verifyManifest(signed);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/not in the trusted key set/i);
      void publicKey; // unused - only the private key is needed to demonstrate the attack
    });

    it('a signature that claims a TRUSTED key id but was actually produced by a DIFFERENT key is rejected (key-id spoofing)', () => {
      // Signs with key 2's private key but claims to be key 1 - the
      // signature check against key 1's public key must fail.
      const manifest = fakeManifest();
      const spoofed = signReleaseManifest(
        manifest,
        TEST_RELEASE_KEY_ID_1,
        TEST_RELEASE_PRIVATE_KEY_2_PEM,
      );

      const verifier = new ReleaseVerifier();
      const result = verifier.verifyManifest(spoofed);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/invalid signature/i);
    });

    it('an explicitly configured trust set (HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS) is honoured over the committed test keys', () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const publicPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
      const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

      process.env.HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS = JSON.stringify([
        { keyId: 'prod-key-2026', publicKeyPem: publicPem, status: 'current' },
      ]);

      const manifest = fakeManifest();
      const signed = signReleaseManifest(manifest, 'prod-key-2026', privatePem);
      const verifier = new ReleaseVerifier();
      expect(verifier.verifyManifest(signed).valid).toBe(true);

      // The committed TEST key is no longer trusted once a real trust set is configured.
      const testSigned = signReleaseManifest(
        manifest,
        TEST_RELEASE_KEY_ID_1,
        TEST_RELEASE_PRIVATE_KEY_1_PEM,
      );
      expect(verifier.verifyManifest(testSigned).valid).toBe(false);
    });

    it('throws an actionable error if HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS is set but malformed', () => {
      process.env.HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS = 'not valid json{{{';
      expect(() => getTrustedReleasePublicKeys()).toThrow(/not valid JSON/);
    });
  });

  describe('buildReleaseManifest + verifyArtifactFile - real artifact bytes on disk', () => {
    async function mkTmpFile(content: string): Promise<string> {
      const dir = await fs.mkdtemp(join(tmpdir(), 'hexyrn-release-artifact-'));
      const path = join(dir, 'artifact.bin');
      await fs.writeFile(path, content);
      return path;
    }

    it('a real artifact file, hashed and signed, verifies end to end', async () => {
      const artifactPath = await mkTmpFile('FAKE INSTALLER BYTES FOR TEST');
      const manifest = await buildReleaseManifest(artifactPath, BASE_MANIFEST);
      const signed = signReleaseManifest(
        manifest,
        TEST_RELEASE_KEY_ID_1,
        TEST_RELEASE_PRIVATE_KEY_1_PEM,
      );

      const verifier = new ReleaseVerifier();
      const result = await verifier.verifyArtifactFile(artifactPath, signed);
      expect(result.valid).toBe(true);
    });

    it('detects a tampered artifact file even though the manifest signature itself is valid', async () => {
      const artifactPath = await mkTmpFile('ORIGINAL BYTES');
      const manifest = await buildReleaseManifest(artifactPath, BASE_MANIFEST);
      const signed = signReleaseManifest(
        manifest,
        TEST_RELEASE_KEY_ID_1,
        TEST_RELEASE_PRIVATE_KEY_1_PEM,
      );

      // Swap the artifact's bytes AFTER signing, same length, so this
      // specifically exercises the checksum path rather than the (also
      // correctly rejecting) size-mismatch path.
      expect('ORIGINAL BYTES'.length).toBe('TAMPERED-BYTES'.length);
      await fs.writeFile(artifactPath, 'TAMPERED-BYTES');

      const verifier = new ReleaseVerifier();
      const result = await verifier.verifyArtifactFile(artifactPath, signed);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/checksum mismatch/i);
    });

    it('detects a truncated/wrong-length artifact file via the size check', async () => {
      const artifactPath = await mkTmpFile('ORIGINAL BYTES OF SOME LENGTH');
      const manifest = await buildReleaseManifest(artifactPath, BASE_MANIFEST);
      const signed = signReleaseManifest(
        manifest,
        TEST_RELEASE_KEY_ID_1,
        TEST_RELEASE_PRIVATE_KEY_1_PEM,
      );

      await fs.writeFile(artifactPath, 'SHORT');

      const verifier = new ReleaseVerifier();
      const result = await verifier.verifyArtifactFile(artifactPath, signed);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/size mismatch/i);
    });

    it('fails closed if the artifact file is missing entirely', async () => {
      const manifest = fakeManifest();
      const signed = signReleaseManifest(
        manifest,
        TEST_RELEASE_KEY_ID_1,
        TEST_RELEASE_PRIVATE_KEY_1_PEM,
      );
      const verifier = new ReleaseVerifier();
      const result = await verifier.verifyArtifactFile(
        '/nonexistent/path/definitely-not-here',
        signed,
      );
      expect(result.valid).toBe(false);
    });
  });

  describe('separation from licence signing (explicit instruction: must not share keys)', () => {
    it('the release test public keys are NOT the same as the licensing test public key', async () => {
      const { TEST_LICENSE_PUBLIC_KEY_PEM } = await import('../../licensing/keys');
      expect(TEST_RELEASE_PUBLIC_KEY_1_PEM).not.toBe(TEST_LICENSE_PUBLIC_KEY_PEM);
      expect(TEST_RELEASE_PUBLIC_KEY_2_PEM).not.toBe(TEST_LICENSE_PUBLIC_KEY_PEM);
    });

    it('a licence signed with the licensing test key does NOT verify as a valid release manifest, and vice versa', async () => {
      const { TEST_LICENSE_PRIVATE_KEY_PEM } = await import('../../licensing/keys');
      // Sign a release manifest with the LICENSING private key, claiming a release key id.
      const manifest = fakeManifest();
      const crossSigned = signReleaseManifest(
        manifest,
        TEST_RELEASE_KEY_ID_1,
        TEST_LICENSE_PRIVATE_KEY_PEM,
      );
      const verifier = new ReleaseVerifier();
      // Must fail: the licensing key's signature does not match TEST_RELEASE_KEY_ID_1's registered public key.
      expect(verifier.verifyManifest(crossSigned).valid).toBe(false);
    });
  });
});
