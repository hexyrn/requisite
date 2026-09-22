# ADR 0004: Simplified license verification in P1

## Status
Accepted (P1), documented simplification.

## What Architecture v1.0 §9 specifies
A signed license file, asymmetrically verified against an embedded public
key, with `signature_valid_at` recording when that verification last
succeeded. Once recorded, a license is durable local state - re-verification
is a pure local cryptographic check, never a network call.

## What P1 actually implements
`ApplicationRegistryService.grantLicense()` accepts a `licensePayload`
object, checks only that it is a non-null object, and records
`signature_valid_at = now()`. **No asymmetric signature verification is
performed.** There is no embedded public key, no signing tooling, and no
verification step beyond "is this a plausible object."

## Why
P1's job is the *platform mechanism* - the three-property model (license /
compatibility / support) as independent, non-conflated state, the data
shape, and every consumer of that state (`getApplicationState`,
`ApplicationActiveGuard`, the capability resolver, the event dispatcher)
correctly treating "licensed" as one of four independent gates. Building
real asymmetric signing (key generation/rotation tooling, a signing
service, embedding a public key in the Core build, and a verification
routine with proper failure handling) is a separable, security-sensitive
piece of work with no dependency on anything else in P1 - none of the P1
acceptance criteria require it to be cryptographically real, only that the
*mechanism* (a license record independently gates activation, survives
compatibility failures, isn't destroyed by installing a newer major
version) works correctly, which is fully testable and tested
(`app-registry.integration.spec.ts`) without real signatures.

## Consequences
- Any caller of `grantLicense` can currently "license" any app for any
  organisation - there is no cryptographic barrier preventing a
  self-hosted operator (or, more importantly, application code with access
  to this service) from granting itself a license without going through
  a real licensing/purchase flow.
- This is **acceptable for P1** because `grantLicense` is not exposed via
  any HTTP endpoint in P1 - it is only ever called from test setup and
  from Core's own internal registration code. There is no attacker-facing
  surface that depends on the signature actually being unforgeable yet.
- **Before any commercial app ships** (P2+), this must be replaced with
  real signature verification - a self-hosted operator or embedded
  license-granting endpoint without real verification would be a genuine
  revenue-integrity and security issue at that point, not merely an
  incomplete feature. Tracked as required pre-commercial-launch work, not
  optional polish.

## Migration path
1. Add a real signing tool (offline, Hexyrn-side) producing a payload +
   detached signature.
2. Embed the corresponding public key in the Core build (environment/
   config, per the existing Shared Responsibility pattern used for
   `TOTP_MASTER_KEY`).
3. `grantLicense` verifies the signature against the embedded public key
   before recording `signature_valid_at`; an invalid signature is rejected
   outright, never recorded.
4. No schema change needed - `license_payload`/`signature_valid_at` already
   have the right shape for this.
