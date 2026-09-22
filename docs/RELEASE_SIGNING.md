# Release signing (P3 items 16, 26, 27)

## What this covers

Every distributable Hexyrn artifact (Windows installer, Docker image,
offline update package) ships alongside a **release manifest**: a small
signed JSON document naming the artifact, its versions, and a SHA-256 hash
of its actual bytes. An installation verifies the manifest's signature
against a locally-configured set of trusted public keys, then verifies the
artifact's hash matches, before ever installing or updating anything. No
network call is involved - verification is pure local cryptography, exactly
like licence verification (`docs/decisions/0006-real-license-verification.md`).

This is implemented in `apps/api/src/platform/release-signing/`:
`release-manifest.ts` (the shape + canonical serialization),
`release-signer.ts` (signs a manifest - used by Hexyrn's own release
process, not by customer installations), `release-verifier.ts`
(`ReleaseVerifier` - what an installer/updater calls), and `release-keys.ts`
(trusted public key configuration).

## Release signing is a SEPARATE key domain from licence signing

`apps/api/src/platform/licensing/keys.ts` (licence signing) and
`apps/api/src/platform/release-signing/release-keys.ts` (release signing)
are independent modules with independent dev/test keypairs. This is
deliberate, not incidental: a compromise of one signing domain must never
let an attacker forge material in the other. Both use Ed25519, but Ed25519
being the same algorithm in both places is not a reason to share a key -
`apps/api/src/platform/release-signing/__tests__/release-signing.spec.ts`
includes an explicit test proving a manifest signed with the licensing
test key does NOT verify as a release manifest, and vice versa.

## Key rotation - historical releases must stay verifiable

`getTrustedReleasePublicKeys()` returns a **set** of trusted keys, each
with a `keyId` and a `status` (`'current'` or `'historical'`), not a single
key. `ReleaseVerifier.verifyManifest()` looks up the manifest's declared
`signingKeyId` in that set:

- A key marked `'historical'` still verifies successfully - a release
  signed years ago with an older key does not suddenly become untrusted
  just because Hexyrn now signs new releases with a newer `'current'` key.
- A `signingKeyId` that is not in the set at all is rejected outright, even
  if the signature is cryptographically valid under some other real key
  (tested explicitly - a real, freshly generated Ed25519 keypair not in
  the trust set is correctly rejected).
- A manifest that claims a trusted `keyId` but was actually signed with a
  *different* key is rejected (key-id spoofing) - the signature check is
  against that specific key's public key, not "any key in the set."

To add a new signing key (e.g. annual rotation, or after a suspected
compromise of the signing environment): generate a new keypair in Hexyrn's
signing environment, add its public half to the trust set with
`status: 'current'`, mark the previous key `'historical'` (do not remove
it - existing installations must keep verifying old releases), and start
signing new releases with the new key. Revoking a key entirely (removing
it from the trust set) is a separate, harder decision - it makes every
release ever signed with that key unverifiable, which should only happen
after a confirmed compromise, not as routine rotation.

## Configuration

`HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS` - a JSON array of
`{keyId, publicKeyPem, status}`. If unset, verification falls back to the
publicly-committed DEV/TEST keypairs in `release-keys.ts` (unmistakably
test keys - both halves committed, which a real production key never would
be) and logs a loud structured warning (`release_signing.using_test_public_keys`)
every time it does, exactly the same pattern as
`HEXYRN_LICENSE_PUBLIC_KEY`'s fallback warning. A production deployment
that never sets this variable would accept a release "signed" with a
publicly-known test key - the warning exists specifically so this can
never happen silently.

## PRODUCTION OPERATIONAL REQUIREMENT (read before GA)

**Hexyrn's production release-signing private key must be generated and
retained outside this source repository and outside customer software,
using appropriately secured Hexyrn-controlled key storage. Only public
verification keys are ever distributed to installations, via
`HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS`.**

This document does **not** decide the specific physical/HSM/cloud-KMS
mechanism for that storage (an offline air-gapped signing machine, a cloud
KMS with restricted IAM, a hardware security module, etc.) - that is a
pre-GA operational decision for Hexyrn to make deliberately, with its own
threat-modelling, and is explicitly out of scope for this codebase to
invent unilaterally. What this codebase guarantees structurally, regardless
of which mechanism is chosen:

- No production private key can ever be committed here by accident being
  "just how the code works" - `release-signer.ts`'s `signReleaseManifest()`
  takes a private key PEM as an explicit parameter; nothing in this
  repository calls it with anything other than the committed dev/test keys
  (see the test suite). Wiring it to a real production key happens entirely
  outside this repository, in Hexyrn's own release tooling/environment.
- Verification never needs the private key at all - `ReleaseVerifier` only
  ever holds public keys, so a customer installation's copy of this
  software structurally cannot leak or misuse the private key, because it
  never has it.
- The trust-set model above means the production key choice can be made,
  and later rotated, without any code change in this repository - only a
  configuration change (`HEXYRN_RELEASE_TRUSTED_PUBLIC_KEYS`).

## What is NOT yet built

- No CLI tool wraps `buildReleaseManifest`/`signReleaseManifest` into a
  one-command release-signing workflow yet - the functions exist and are
  tested, but an operator-facing script (mirroring `apps/api/src/db/migrate.ts`'s
  explicit-CLI-step pattern) is separate, smaller follow-up work.
- No installer/updater code calls `ReleaseVerifier.verifyArtifactFile()`
  yet - that integration happens as part of the Windows packaging (P3
  item 3/4) and update system (P3 items 14/15) work, which reference this
  module rather than reimplementing verification.
