import { sign as edSign, createHash } from 'crypto';
import { promises as fs } from 'fs';
import { ReleaseManifest, SignedReleaseManifest, canonicalizeManifest } from './release-manifest';

/**
 * Signs a release manifest with a given Ed25519 PRIVATE key (PEM, PKCS8).
 * NEVER used with a production private key inside this repository/process
 * in normal operation - see release-keys.ts's doc comment. This function
 * exists so the signing OPERATION is implemented and tested (with dev/test
 * keys), not because this codebase is where production signing happens;
 * the real production signing procedure runs this same logic (or an
 * equivalent) in Hexyrn's own offline signing environment, feeding it the
 * real private key from secured storage outside this repo.
 */
export function signReleaseManifest(
  manifest: ReleaseManifest,
  signingKeyId: string,
  privateKeyPem: string,
): SignedReleaseManifest {
  const signature = edSign(null, Buffer.from(canonicalizeManifest(manifest)), privateKeyPem);
  return { ...manifest, signingKeyId, signature: signature.toString('base64') };
}

/** Computes the manifest fields (minus signature) for a real artifact file on disk - the actual hash a customer's installer/download would produce. */
export async function buildReleaseManifest(
  artifactPath: string,
  fields: Omit<ReleaseManifest, 'artifactSha256' | 'artifactSizeBytes' | 'builtAt'>,
): Promise<ReleaseManifest> {
  const bytes = await fs.readFile(artifactPath);
  return {
    ...fields,
    artifactSha256: createHash('sha256').update(bytes).digest('hex'),
    artifactSizeBytes: bytes.length,
    builtAt: new Date().toISOString(),
  };
}
