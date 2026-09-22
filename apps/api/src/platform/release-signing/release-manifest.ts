/**
 * Release manifest shape + canonical serialization (P3 items 16/29). A
 * release manifest describes ONE distributable artifact (a Windows
 * installer, a Docker image tag, an offline update package) - what it is,
 * what versions it contains, and a hash of its actual bytes, all covered
 * by a single Ed25519 signature so tampering with either the manifest's
 * claims or the artifact itself is detectable.
 *
 * Deliberately separate from platform/licensing/license-payload.ts's
 * LicensePayload - different domain, different fields, different signing
 * keys (release-keys.ts, not licensing/keys.ts) - conflating them would
 * make it possible for a licence-signing compromise to also forge release
 * artifacts, or vice versa.
 */
export interface ReleaseManifest {
  formatVersion: 1;
  /** e.g. 'hexyrn-core', 'hexyrn-requisite' - which product this artifact is. */
  productId: string;
  /** The product version this release identifies as, e.g. '1.0.0-rc1'. */
  version: string;
  /** Architecture §29: Core version this artifact requires/targets, independent of productVersion. */
  requiresCoreVersion: string;
  /** e.g. 'windows-x64-installer', 'docker-image', 'offline-update-package'. */
  artifactType: string;
  /** SHA-256 of the artifact's actual bytes, hex-encoded. */
  artifactSha256: string;
  artifactSizeBytes: number;
  builtAt: string; // ISO 8601
  /** Migration requirements this artifact's install/update would need to run - surfaced to the update system (P3 item 14) before it proceeds. */
  migrationNotes: string | null;
}

export interface SignedReleaseManifest extends ReleaseManifest {
  /** Which trusted key (release-keys.ts's TrustedKeyEntry.keyId) produced `signature` - required, not inferred, so verification never has to guess-and-check every trusted key. */
  signingKeyId: string;
  /** base64-encoded Ed25519 signature over canonicalize(manifest fields, excluding signingKeyId/signature themselves). */
  signature: string;
}

/** Deterministic JSON serialization: sorted keys, no extra whitespace - same discipline as license-payload.ts's canonicalize(), for the same reason (a signature must cover exact bytes, not "equivalent" JSON). */
export function canonicalizeManifest(manifest: ReleaseManifest): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(manifest).sort()) {
    sorted[key] = (manifest as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}
