# ADR 0002: TOTP secret encryption - single master key now, envelope encryption deferred

## Status

**Superseded (P3 item 7, 2026-09-22) by real envelope encryption + rotation -
see `docs/decisions/0008-totp-envelope-encryption.md`.** This document is
retained unmodified below for historical record of the P0 state and
rationale; it is no longer the current implementation.

## Status (original, P0)

Accepted (P0), with an explicit, tracked follow-up (not silent debt).

## What Architecture v1.0 §6 specifies

> TOTP secret encryption/key management: TOTP secrets encrypted at rest
> using envelope encryption - a per-installation master key (from
> environment/secrets file, never committed, documented as the customer's
> responsibility to protect under Shared Responsibility) wraps per-secret
> data keys stored alongside the encrypted secret. Master key rotation
> re-wraps data keys without re-issuing user TOTP enrolments.

Envelope encryption here means: each TOTP secret is encrypted with its own
randomly generated **data key**; that data key is itself encrypted
("wrapped") by a single, rarely-rotated **master key**. Rotating the master
key means re-encrypting only the (small) data keys, not every TOTP secret -
so rotation is cheap and doesn't force every user to re-enrol MFA.

## What P0 actually implements

`apps/api/src/security/totp-encryption.ts` implements **direct
single-master-key encryption**, not envelope encryption:

- One master key, read from `TOTP_MASTER_KEY` (base64-encoded, must decode
  to exactly 32 bytes), never committed, operator-provided via environment/
  secrets file - matching the "customer's responsibility under Shared
  Responsibility" part of §6.
- Each TOTP secret is encrypted directly with that master key using
  AES-256-GCM (a random 96-bit IV per secret, authenticated so tampering is
  detected - see `decryptTotpSecret`'s AEAD tag check).
- There is **no per-secret data key** and **no wrapping layer**.

## Why this deviates from §6, stated plainly

Implementing genuine envelope encryption correctly - generating a random
data key per secret, encrypting the secret with it, encrypting the data key
with the master key, storing both the wrapped data key and the ciphertext,
and writing a rotation procedure that walks every row re-wrapping data keys
without touching the ciphertext - is a meaningful, separable piece of work
with its own testing surface (rotation correctness, partial-rotation
failure handling, key-versioning so old and new master keys can coexist
during a rotation window). Given the volume of P0 work still outstanding
when TOTP was reached, and given that direct single-key encryption still
delivers the security property that actually matters for P0 - **secrets are
never stored in plaintext, and tampering is detected** - implementing it
honestly-labelled-as-simplified and documenting the gap explicitly was
judged the more defensible choice than either (a) skipping encryption
entirely, or (b) writing a rushed, undertested envelope-encryption
implementation under time pressure that claims a security property (safe,
tested rotation) it doesn't actually deliver.

**This is a deviation from Architecture §6, not merely an implementation
detail left open by it** - the architecture is specific about envelope
encryption and rotation-without-re-enrolment being the required behaviour,
and P0 does not provide that. It is recorded here rather than in
`docs/decisions/P0-DEVIATIONS.md` because it is a scoped, single-subsystem
technical decision with its own rationale and migration path, not a
contradiction discovered in the architecture itself; `P0-DEVIATIONS.md`
remains reserved for cases where the architecture was found to be wrong or
unworkable as written, which is not the case here - §6 is workable, P0
simply doesn't implement all of it yet.

## Concrete consequences (so this is evaluable, not just admitted)

1. **Master key rotation is destructive today.** Changing
   `TOTP_MASTER_KEY` makes every previously-encrypted TOTP secret
   permanently undecryptable (AES-GCM will fail the auth tag check, see
   `decryptTotpSecret`, which throws rather than silently returning garbage
   - fail-closed, not fail-open). Every enrolled user would need to
     re-enrol MFA. There is no supported rotation procedure in P0.
2. **Key-loss behaviour**: if `TOTP_MASTER_KEY` is lost entirely, every
   enrolled user's MFA is permanently unusable via the normal challenge
   path - recovery is only possible via the admin-assisted MFA reset path
   described in Architecture §6 (a separate, audited, elevated-permission
   action; not built as an endpoint in P0, tracked as an outstanding P0 gap
   below, not a P1 feature - see the final P0 report's technical-debt list).
3. **Blast radius of a compromised master key**: with envelope encryption,
   rotating the master key after a suspected compromise re-wraps every data
   key cheaply. With direct encryption, the only remediation is forcing
   re-enrolment for every user (see point 1) - there is no cheaper
   mitigation available today.

## Future migration path to real envelope encryption

Not built now, but not architecturally blocked either:

1. Add `totp_secret_data_key_wrapped` alongside the existing
   `totp_secret_encrypted` column.
2. On next successful TOTP verification (or a one-off backfill job) for
   each user still on the old scheme: generate a random data key, encrypt
   the already-decrypted secret with it, encrypt the data key with the
   current master key, write both columns, clear reliance on the old
   direct-encryption path.
3. Add a `master_key_version` marker so a rotation can decrypt old data
   keys with the previous master key and re-encrypt with the new one,
   without touching the (unchanged) TOTP-secret ciphertext.
4. `TOTP_MASTER_KEY` becomes `TOTP_MASTER_KEY_CURRENT` plus an optional
   `TOTP_MASTER_KEY_PREVIOUS` consulted only during an active rotation
   window.

This is a straightforward, additive migration - nothing in the current
schema or `TotpService` API needs to change shape for it, only the
encryption helper's internals and one new column.
