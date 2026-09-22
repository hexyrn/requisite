# ADR 0006: Real Ed25519 license verification (resolves ADR 0004)

## Status
Accepted (P2). Supersedes the verification approach in ADR 0004 - the
LICENSE/COMPATIBILITY/SUPPORT separation and schema from that ADR are
unchanged and remain correct; only the "no real signature verification"
gap is closed.

## What changed
`ApplicationRegistryService.grantLicense` now requires a genuine
`SignedLicense` (`apps/api/src/platform/licensing/license-payload.ts`) and
rejects anything that doesn't verify - a missing/malformed signature, a
tampered payload, or a payload for the wrong app/organisation/major
version is rejected outright with a `BadRequestException`, never
recorded. Verification (`LicenseVerifier`, `license-verifier.ts`) is Ed25519
via Node's built-in `crypto.verify`, using a locally-configured public key
(`HEXYRN_LICENSE_PUBLIC_KEY` env var) - there is no network call anywhere
in the verification path.

## Key handling
- **Production**: the private signing key lives only in Hexyrn's own
  offline license-generation environment and is never committed here.
  Core ships (via `HEXYRN_LICENSE_PUBLIC_KEY`) only the public
  verification key.
- **Dev/test**: `apps/api/src/platform/licensing/keys.ts` commits a real,
  working Ed25519 keypair generated specifically for this repository's
  tests and the reference app. It is unmistakably not the production key:
  both halves are committed (a real production key's private half never
  would be), every use site labels it `TEST_`, and
  `getConfiguredPublicKey()` logs a loud structured warning
  (`licensing.using_test_public_key`) every time it falls back to this key
  because `HEXYRN_LICENSE_PUBLIC_KEY` isn't set - this is visible in
  ordinary test output (see any P2 test run) specifically so it can never
  be mistaken for quiet, intended production behaviour.

## Canonical payload format
`LicensePayload` = `{ licenseId, appId, organisationId, majorVersion,
issuedAt, supportExpiresAt }`. Signed as `Ed25519(canonicalize(payload))`
where `canonicalize` produces a deterministic, sorted-key JSON string - the
signature covers exactly these fields and nothing else, so a license
cannot be silently reused for a different app/org/version by copy-pasting
the signature onto a modified payload (`canonicalize`'s output changes,
so the signature no longer matches).

## Verified test coverage (`licensing.spec.ts`, 14/14 passing)
Valid signature; invalid/garbage signature; modified payload (both a
structural field like `majorVersion` and a semantically-tempting field like
`supportExpiresAt`); wrong organisation; wrong product; wrong major
version; support expiry does NOT disable runtime (verified true - support
status is informational, `ApplicationRegistryService` never gates
`licensed`/`active` on `support_expires_at`); no network connectivity
(verification is synchronous, sub-50ms, no I/O); an older major-version
license remains valid independently of a newer one also existing; a
license signed with a genuinely different (non-Hexyrn) keypair is
rejected, proving the public key is actually enforced; and the
`HEXYRN_LICENSE_PUBLIC_KEY` override correctly switches which key is
trusted.

## Consequences
- Every P1-era test that called `grantLicense` with a fake `{ signature:
  'x' }` payload was updated to use a real signed test license
  (`test-utils/test-db.ts`'s `createTestLicense` helper, built on
  `LicenseSigner` + the committed test keypair) - all 198 tests across the
  full P0+P1+P2 suite pass with real verification now enforced everywhere,
  not just in the dedicated licensing tests.
- `docs/decisions/0004-app-licensing-simplification.md` is retained
  unmodified for historical record (it accurately describes the P1 state
  at the time); this ADR is the current state.
