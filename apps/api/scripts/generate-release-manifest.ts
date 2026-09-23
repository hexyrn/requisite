/**
 * Release manifest generator CLI (P3 items 16/26/29/37). Produces a real,
 * signed `.manifest.json` for a real artifact file on disk - the actual
 * tool a Hexyrn release engineer runs against a built installer/Docker
 * image tarball/offline update package before it is distributed, and the
 * same shape apps/web/src/admin/AdminUpdatePage.tsx's "Updates" screen
 * and apps/api/src/platform/update/update.controller.ts's `/update/check`
 * expect to verify against (release-verifier.ts).
 *
 * Deliberately thin: all the real logic (hashing, canonical
 * serialization, Ed25519 signing) already exists and is unit-tested in
 * release-manifest.ts/release-signer.ts - this script is just the CLI
 * wiring so that logic is actually reachable as a real release-pipeline
 * step, not only as a library other code could theoretically call.
 *
 * Usage:
 *   npx ts-node scripts/generate-release-manifest.ts \
 *     --artifact ./dist-release/hexyrn-core-1.0.0.tar.gz \
 *     --product-id hexyrn-core \
 *     --version 1.0.0 \
 *     --requires-core-version ">=1.0.0" \
 *     --artifact-type docker-image \
 *     [--migration-notes "..."] \
 *     [--signing-key-id test-release-key-1] \
 *     [--signing-key-pem-file ./release-signing-key.pem] \
 *     [--out ./dist-release/hexyrn-core-1.0.0.manifest.json]
 *
 * SIGNING KEY: by default, uses the publicly-committed TEST release
 * key (release-keys.ts's TEST_RELEASE_PRIVATE_KEY_1_PEM) - correct for
 * development/CI, NEVER for a real release (see release-keys.ts's own
 * doc comment: the real private key must never be in this repository or
 * this process in production - --signing-key-pem-file exists so a real
 * release pipeline can feed in the actual key from secured storage
 * without this script needing to know anything about how it's stored).
 */
import { promises as fs } from 'fs';
import { buildReleaseManifest, signReleaseManifest } from '../src/platform/release-signing/release-signer';
import { TEST_RELEASE_KEY_ID_1, TEST_RELEASE_PRIVATE_KEY_1_PEM } from '../src/platform/release-signing/release-keys';

interface Args {
  artifact: string;
  productId: string;
  version: string;
  requiresCoreVersion: string;
  artifactType: string;
  migrationNotes: string | null;
  signingKeyId: string;
  signingKeyPemFile: string | null;
  out: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const artifact = get('--artifact');
  const productId = get('--product-id');
  const version = get('--version');
  const requiresCoreVersion = get('--requires-core-version');
  const artifactType = get('--artifact-type');
  if (!artifact || !productId || !version || !requiresCoreVersion || !artifactType) {
    throw new Error(
      'Required: --artifact <path> --product-id <id> --version <semver> --requires-core-version <range> --artifact-type <type>',
    );
  }
  return {
    artifact,
    productId,
    version,
    requiresCoreVersion,
    artifactType,
    migrationNotes: get('--migration-notes') ?? null,
    signingKeyId: get('--signing-key-id') ?? TEST_RELEASE_KEY_ID_1,
    signingKeyPemFile: get('--signing-key-pem-file') ?? null,
    out: get('--out') ?? null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const usingTestKey = !args.signingKeyPemFile;
  if (usingTestKey) {
    console.warn(
      'WARNING: no --signing-key-pem-file given - signing with the PUBLICLY COMMITTED TEST release key. ' +
        'This manifest will NOT be trusted by any installation configured with a real HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS. ' +
        'Fine for development/CI; never use this for a real customer-facing release.',
    );
  }
  const privateKeyPem = args.signingKeyPemFile ? await fs.readFile(args.signingKeyPemFile, 'utf8') : TEST_RELEASE_PRIVATE_KEY_1_PEM;

  const manifest = await buildReleaseManifest(args.artifact, {
    formatVersion: 1,
    productId: args.productId,
    version: args.version,
    requiresCoreVersion: args.requiresCoreVersion,
    artifactType: args.artifactType,
    migrationNotes: args.migrationNotes,
  });

  const signed = signReleaseManifest(manifest, args.signingKeyId, privateKeyPem);

  const outPath = args.out ?? `${args.artifact}.manifest.json`;
  await fs.writeFile(outPath, JSON.stringify(signed, null, 2), 'utf8');

  console.log(`Release manifest written: ${outPath}`);
  console.log(`  artifact: ${args.artifact} (${manifest.artifactSizeBytes} bytes)`);
  console.log(`  sha256:   ${manifest.artifactSha256}`);
  console.log(`  product:  ${manifest.productId} ${manifest.version} (requires core ${manifest.requiresCoreVersion})`);
  console.log(`  signed by: ${signed.signingKeyId}${usingTestKey ? ' (TEST KEY)' : ''}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
