import { verify as edVerify, createHash } from 'crypto';
import { promises as fs } from 'fs';
import { Injectable } from '@nestjs/common';
import { SignedReleaseManifest, canonicalizeManifest } from './release-manifest';
import { getTrustedReleasePublicKeys, TrustedKeyEntry } from './release-keys';

export interface ReleaseVerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Release manifest/artifact verification (P3 items 16/26/27). Pure, local,
 * offline - no network call, same discipline as LicenseVerifier. Verifies
 * THREE independent things, all required:
 *   1. The signature is valid Ed25519 over the manifest's canonical form.
 *   2. The signing key id is in the current trust set (key rotation
 *      support: an OLD key that's still listed as 'historical' still
 *      verifies successfully - it does not become unverifiable just
 *      because a newer 'current' key now exists. An UNKNOWN key id -
 *      never listed at all - is rejected outright).
 *   3. (verifyArtifactFile only) The artifact's actual on-disk bytes hash
 *      to exactly what the manifest claims - catching a tampered/corrupted
 *      download even if the manifest itself is validly signed.
 */
@Injectable()
export class ReleaseVerifier {
  verifyManifest(manifest: SignedReleaseManifest, trustedKeys: TrustedKeyEntry[] = getTrustedReleasePublicKeys()): ReleaseVerificationResult {
    const trusted = trustedKeys.find((k) => k.keyId === manifest.signingKeyId);
    if (!trusted) {
      return {
        valid: false,
        reason: `Signing key id "${manifest.signingKeyId}" is not in the trusted key set - this release manifest was not signed by a key this installation trusts.`,
      };
    }

    const { signingKeyId: _signingKeyId, signature, ...unsigned } = manifest;
    let signatureValid: boolean;
    try {
      signatureValid = edVerify(null, Buffer.from(canonicalizeManifest(unsigned)), trusted.publicKeyPem, Buffer.from(signature, 'base64'));
    } catch {
      return { valid: false, reason: 'Malformed signature.' };
    }
    if (!signatureValid) {
      return { valid: false, reason: 'Invalid signature - the release manifest does not match its signature.' };
    }

    return { valid: true };
  }

  /** Full verification including the artifact's actual bytes on disk - what an installer/updater should call before trusting a downloaded artifact. */
  async verifyArtifactFile(
    artifactPath: string,
    manifest: SignedReleaseManifest,
    trustedKeys: TrustedKeyEntry[] = getTrustedReleasePublicKeys(),
  ): Promise<ReleaseVerificationResult> {
    const manifestResult = this.verifyManifest(manifest, trustedKeys);
    if (!manifestResult.valid) return manifestResult;

    let bytes: Buffer;
    try {
      bytes = await fs.readFile(artifactPath);
    } catch (err) {
      return { valid: false, reason: `Could not read artifact file: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (bytes.length !== manifest.artifactSizeBytes) {
      return { valid: false, reason: `Artifact size mismatch (manifest says ${manifest.artifactSizeBytes} bytes, file is ${bytes.length} bytes) - the download may be truncated or wrong.` };
    }
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== manifest.artifactSha256) {
      return { valid: false, reason: `Artifact checksum mismatch (expected ${manifest.artifactSha256}, got ${actualSha256}) - the file has been tampered with or corrupted.` };
    }

    return { valid: true };
  }
}
