# ADR 0008: Real TOTP envelope encryption + master key rotation (resolves ADR 0002)

## Status

Accepted (P3 item 7, 2026-09-22). Supersedes ADR 0002's P0 direct-encryption
scheme - the security property Architecture §6 requires (data keys
per-secret, master key rotation without re-enrolment) is now genuinely
implemented, not deferred.

## What changed

`apps/api/src/security/totp-encryption.ts` now implements real envelope
encryption: each TOTP secret is encrypted with its own random 32-byte data
key; the data key is wrapped by a master key. `TOTP_MASTER_KEY_CURRENT`
(new secrets, and the key rotation re-wraps TO) and
`TOTP_MASTER_KEY_PREVIOUS` (set only during an active rotation window, so
secrets not yet re-wrapped stay decryptable) replace the single
`TOTP_MASTER_KEY` var, which is retained as a fallback for
`TOTP_MASTER_KEY_CURRENT` so an existing deployment's env config keeps
working unchanged.

## Key resolution is by trial, not by a stored label - a real bug found and fixed during this work

The first implementation attempt stored a `'current'`/`'previous'` label in
the encrypted value at encryption time and trusted that label at
decryption time to pick which env var to use. This is wrong: the
operational rotation procedure reassigns which _physical_ key each env var
holds (the outgoing key moves from `_CURRENT` to `_PREVIOUS`), so a secret
encrypted before that reassignment carries a now-stale label - a real
regression test written for the rotation flow caught this immediately (AES-GCM
auth-tag failure, not silent corruption - fail-closed, but still wrong
behaviour that would have broken every user's MFA during the exact window
rotation is meant to support). Fixed by resolving keys through trial:
`decryptTotpSecret`/`rotateMasterKeyWrapping` attempt
`TOTP_MASTER_KEY_CURRENT` first, then `TOTP_MASTER_KEY_PREVIOUS` if
configured, and use whichever one actually authenticates - no label is
stored or trusted. See the file's doc comment for the full explanation;
recorded here because it is exactly the kind of design mistake a reviewer
should be able to see was caught by a test, not shipped.

## Backward compatibility

A secret encrypted under the pre-P3 direct scheme (`<iv>.<tag>.<ciphertext>`,
no data key, detected by the absence of the `v2.` prefix) is still
decryptable via the same trial-based key resolution. It is not
automatically upgraded to the envelope format - `rotateMasterKeyWrapping`
explicitly leaves legacy-format secrets unchanged (`changed: false`), since
rotation is a data-key re-wrap operation and a legacy secret has no data
key to re-wrap. A full backfill migration (re-encrypt every legacy secret
into the envelope format, e.g. on next successful verification) remains
narrower, separate follow-up work, not required to satisfy P3 item 7's
"resolve the rotation debt" - every user who enrols MFA from this point
forward gets the envelope format and real rotation support immediately.

## Rotation mechanism

`TotpService.rotateAllMasterKeys(db)` runs a per-organisation rotation pass
(reads every user with a stored secret, calls `rotateMasterKeyWrapping`,
writes back only changed rows) and is fault-tolerant per row: one
unrotatable secret (e.g. wrapped under a key from an even earlier rotation
that `TOTP_MASTER_KEY_PREVIOUS` no longer holds) is reported in a `failed`
array rather than aborting every other user's rotation - a real robustness
bug found via the same integration test (initially the whole batch threw
on the first row it couldn't open). It is deliberately per-organisation,
not a cross-org sweep, matching ADR 0005's established pattern of avoiding
any BYPASSRLS-equivalent path for background work; an installation-wide
rotation script enumerates organisations and calls this once per org.

## Verified test coverage

- `apps/api/src/security/__tests__/totp-encryption.spec.ts` (15/15): basic
  round-trip, envelope format shape, random IV/data-key per encryption,
  fail-closed on tampered ciphertext, legacy-format backward compatibility,
  legacy `TOTP_MASTER_KEY` fallback, full rotation round-trip (proving the
  secret ciphertext bytes are untouched by rotation - only the wrapped data
  key changes), rotation idempotency, legacy secrets correctly left
  unrotated, and the key-loss failure mode (missing
  `TOTP_MASTER_KEY_PREVIOUS`) failing closed with an actionable message.
- `apps/api/src/__tests__/http-e2e.integration.spec.ts`, `describe('TOTP
master key rotation (P3 item 7, real DB round-trip)')`: a real user
  enrols MFA via the actual HTTP flow, the master key is rotated mid-test,
  `rotateAllMasterKeys` is run against the real database, the rotation
  window is closed (previous key removed), and the user's MFA challenge is
  proven to still work correctly afterward - plus proof that an unrelated
  user's non-rotatable secret does not block this rotation pass.

## What was NOT built (explicitly, not silently)

- No automated legacy-to-envelope backfill migration (see "Backward
  compatibility" above).
- No CLI/admin-UI surface to trigger a rotation pass yet - `TotpService.
rotateAllMasterKeys` exists and is tested, but an operator-facing command
  (mirroring `apps/api/src/db/migrate.ts`'s explicit-CLI-step pattern) is
  P3 packaging/operations work, tracked separately.
- No installation-wide (all-organisations) rotation orchestrator - the
  per-org enumeration loop described above is documented, not yet written
  as a runnable script.
