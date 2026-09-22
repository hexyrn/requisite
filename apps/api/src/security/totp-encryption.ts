import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * TOTP secret encryption at rest - envelope encryption (P3 item 7 resolves
 * the P0 simplification tracked in docs/decisions/0002-totp-secret-encryption.md).
 *
 * Each TOTP secret is encrypted with its own randomly generated 32-byte
 * DATA KEY; that data key is itself encrypted ("wrapped") by a master key.
 * Rotating the master key means re-wrapping the (small) data keys via
 * rotateMasterKeyWrapping() below, never re-encrypting or touching the TOTP
 * secret ciphertext itself, and never forcing users to re-enrol MFA - this
 * is exactly the property Architecture §6 requires and ADR 0002 deferred.
 *
 * Master key configuration:
 *   - TOTP_MASTER_KEY_CURRENT - the key new secrets are wrapped under.
 *     Falls back to the legacy TOTP_MASTER_KEY var if unset, so an
 *     existing deployment's env config keeps working unchanged.
 *   - TOTP_MASTER_KEY_PREVIOUS - set ONLY during an active rotation window,
 *     so secrets still wrapped under the outgoing key remain decryptable
 *     while rotateMasterKeyWrapping() works through them. Remove it once
 *     rotation is complete.
 *
 * Key resolution is done BY TRIAL, not by trusting a version label baked
 * into the stored value at encryption time: decryptTotpSecret() attempts
 * TOTP_MASTER_KEY_CURRENT first, and if that fails to authenticate (AES-GCM
 * rejects tampered/wrong-key ciphertext), falls back to
 * TOTP_MASTER_KEY_PREVIOUS if configured. This is deliberate, not an
 * afterthought: an earlier version of this mechanism stored a 'current'/
 * 'previous' label at encryption time and trusted it at decryption time -
 * but that label describes a ROLE, and the operational rotation procedure
 * (set PREVIOUS to the outgoing key, set CURRENT to the new key) reassigns
 * which physical key holds which role. A secret encrypted before that
 * reassignment, carrying a stale 'current' label, would then be decrypted
 * with the WRONG physical key and fail - precisely during the rotation
 * window, which is exactly when this needs to keep working. Trying both
 * configured keys by actual decryption success removes that entire failure
 * mode; the label problem doesn't exist if there's no label to trust.
 *
 * Storage format: `v2.<wrapIv>.<wrapTag>.<wrappedDataKey>.<iv>.<tag>.<ciphertext>`,
 * all base64, dot-joined.
 *
 * Backward compatibility: a secret encrypted by the pre-P3 direct scheme
 * (`<iv>.<tag>.<ciphertext>`, no `v2.` prefix, no data key) is still
 * decryptable - decryptTotpSecret() detects the format (by part count) and
 * decrypts it directly with the resolved current/previous key, exactly as
 * before. It is NOT automatically upgraded to the envelope format; ADR
 * 0002's documented migration step (re-wrap on next successful
 * verification, or a one-off backfill) is not implemented here, and
 * remains tracked as narrower follow-up debt - what P3 item 7 required and
 * this closes is genuine envelope encryption + rotation for the mechanism
 * itself, which every NEW enrolment now gets immediately.
 */
const ALGO = 'aes-256-gcm';
const ENVELOPE_PREFIX = 'v2';

function loadKey(envVar: string): Buffer | null {
  const raw = process.env[envVar];
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`${envVar} must decode to exactly 32 bytes (base64-encoded)`);
  }
  return key;
}

function resolveCurrentKey(): Buffer {
  const key = loadKey('TOTP_MASTER_KEY_CURRENT') ?? loadKey('TOTP_MASTER_KEY');
  if (!key) {
    throw new Error('TOTP_MASTER_KEY_CURRENT (or legacy TOTP_MASTER_KEY) is not set');
  }
  return key;
}

function resolvePreviousKey(): Buffer | null {
  return loadKey('TOTP_MASTER_KEY_PREVIOUS');
}

/** Every configured master key, current first - the trial order for decryption/rotation. */
function candidateKeys(): Buffer[] {
  const keys = [resolveCurrentKey()];
  const previous = resolvePreviousKey();
  if (previous) keys.push(previous);
  return keys;
}

interface Sealed {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

function seal(key: Buffer, plaintext: Buffer): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function tryUnseal(key: Buffer, sealed: Sealed): Buffer | null {
  try {
    const decipher = createDecipheriv(ALGO, key, sealed.iv);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    return null; // wrong key or tampered data - caller tries the next candidate / reports failure
  }
}

/** Unseal with the first candidate key that successfully authenticates, or throw if none do. */
function unsealWithAnyKey(sealed: Sealed, keys: Buffer[]): Buffer {
  for (const key of keys) {
    const result = tryUnseal(key, sealed);
    if (result) return result;
  }
  const haveBoth = keys.length > 1;
  throw new Error(
    haveBoth
      ? 'Could not decrypt: neither TOTP_MASTER_KEY_CURRENT nor TOTP_MASTER_KEY_PREVIOUS opens this secret.'
      : 'Could not decrypt with TOTP_MASTER_KEY_CURRENT, and TOTP_MASTER_KEY_PREVIOUS is not set - ' +
          'if this secret was wrapped under an older key, set TOTP_MASTER_KEY_PREVIOUS to that key\'s value to recover access.',
  );
}

function b64(buf: Buffer): string {
  return buf.toString('base64');
}
function fromB64(s: string | undefined): Buffer {
  if (!s) throw new Error('Malformed encrypted TOTP secret');
  return Buffer.from(s, 'base64');
}

export function encryptTotpSecret(plainSecret: string): string {
  const masterKey = resolveCurrentKey();
  const dataKey = randomBytes(32);
  const wrapped = seal(masterKey, dataKey);
  const enc = seal(dataKey, Buffer.from(plainSecret, 'utf8'));
  return [
    ENVELOPE_PREFIX,
    b64(wrapped.iv),
    b64(wrapped.tag),
    b64(wrapped.ciphertext),
    b64(enc.iv),
    b64(enc.tag),
    b64(enc.ciphertext),
  ].join('.');
}

export function decryptTotpSecret(stored: string): string {
  const parts = stored.split('.');

  if (parts[0] === ENVELOPE_PREFIX) {
    const [, wIv, wTag, wCt, iv, tag, ct] = parts;
    const wrapped: Sealed = { iv: fromB64(wIv), tag: fromB64(wTag), ciphertext: fromB64(wCt) };
    const dataKey = unsealWithAnyKey(wrapped, candidateKeys());
    const plain = unsealWithAnyKey({ iv: fromB64(iv), tag: fromB64(tag), ciphertext: fromB64(ct) }, [dataKey]);
    return plain.toString('utf8');
  }

  // Legacy P0 direct-encryption format - no envelope, no data key.
  const [ivB64, tagB64, ctB64] = parts;
  const sealed: Sealed = { iv: fromB64(ivB64), tag: fromB64(tagB64), ciphertext: fromB64(ctB64) };
  const plain = unsealWithAnyKey(sealed, candidateKeys());
  return plain.toString('utf8');
}

/**
 * Master key rotation (Architecture §6: "Master key rotation re-wraps data
 * keys without re-issuing user TOTP enrolments"). Re-wraps ONLY the data
 * key under TOTP_MASTER_KEY_CURRENT - the TOTP secret ciphertext is
 * returned byte-for-byte unchanged. Idempotent: a secret whose data key
 * already opens under TOTP_MASTER_KEY_CURRENT is returned unmodified (no
 * unnecessary write). Legacy (pre-envelope) secrets are returned unmodified
 * too - they are not eligible for this rotation mechanism (see the module
 * doc comment); they remain decryptable via the same trial-based key
 * resolution as decryptTotpSecret() until they are re-enrolled or
 * explicitly backfilled.
 *
 * Operational rotation procedure (documented, not automated end-to-end):
 *   1. Set TOTP_MASTER_KEY_PREVIOUS to the outgoing key's current value.
 *   2. Set TOTP_MASTER_KEY_CURRENT to a freshly generated key.
 *   3. Restart the app (or re-read env in-process, deployment-dependent).
 *   4. Run the rotation pass (TotpService.rotateAllMasterKeys) - it reads
 *      every user's stored secret, calls this function, and writes back
 *      only the ones that changed.
 *   5. Once rotateAllMasterKeys reports zero remaining non-current secrets,
 *      remove TOTP_MASTER_KEY_PREVIOUS.
 */
export function rotateMasterKeyWrapping(stored: string): { value: string; changed: boolean } {
  const parts = stored.split('.');
  if (parts[0] !== ENVELOPE_PREFIX) {
    return { value: stored, changed: false }; // legacy format, not eligible
  }
  const [, wIv, wTag, wCt, iv, tag, ct] = parts;
  const wrapped: Sealed = { iv: fromB64(wIv), tag: fromB64(wTag), ciphertext: fromB64(wCt) };

  const currentKey = resolveCurrentKey();
  if (tryUnseal(currentKey, wrapped)) {
    return { value: stored, changed: false }; // already wrapped under the current key
  }

  const previousKey = resolvePreviousKey();
  if (!previousKey) {
    throw new Error(
      'Could not rotate: this secret is not wrapped under TOTP_MASTER_KEY_CURRENT, and ' +
        'TOTP_MASTER_KEY_PREVIOUS is not set to try. Set it to the outgoing key\'s value before rotating.',
    );
  }
  const dataKey = tryUnseal(previousKey, wrapped);
  if (!dataKey) {
    throw new Error('Could not rotate: this secret opens under neither TOTP_MASTER_KEY_CURRENT nor TOTP_MASTER_KEY_PREVIOUS.');
  }

  const rewrapped = seal(currentKey, dataKey);
  const value = [
    ENVELOPE_PREFIX,
    b64(rewrapped.iv),
    b64(rewrapped.tag),
    b64(rewrapped.ciphertext),
    iv,
    tag,
    ct, // secret ciphertext untouched, byte-for-byte
  ].join('.');
  return { value, changed: true };
}
