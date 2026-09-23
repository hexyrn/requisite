import { createCipheriv, randomBytes } from 'crypto';
import { encryptTotpSecret, decryptTotpSecret, rotateMasterKeyWrapping } from '../totp-encryption';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

describe('TOTP envelope encryption (P3 item 7 - resolves ADR 0002)', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('basic round-trip', () => {
    beforeEach(() => {
      delete process.env.TOTP_MASTER_KEY;
      delete process.env.TOTP_MASTER_KEY_PREVIOUS;
      process.env.TOTP_MASTER_KEY_CURRENT = KEY_A;
    });

    it('encrypts and decrypts a secret correctly', () => {
      const stored = encryptTotpSecret('JBSWY3DPEHPK3PXP');
      expect(decryptTotpSecret(stored)).toBe('JBSWY3DPEHPK3PXP');
    });

    it('uses the v2 envelope format (data key wrapped separately from the secret)', () => {
      const stored = encryptTotpSecret('JBSWY3DPEHPK3PXP');
      const parts = stored.split('.');
      expect(parts[0]).toBe('v2');
      expect(parts).toHaveLength(7); // prefix, wrap(iv,tag,ct), secret(iv,tag,ct)
    });

    it('produces different ciphertext for the same secret each time (random data key + IVs)', () => {
      const a = encryptTotpSecret('JBSWY3DPEHPK3PXP');
      const b = encryptTotpSecret('JBSWY3DPEHPK3PXP');
      expect(a).not.toBe(b);
    });

    it('fails closed (throws, does not return garbage) on a tampered ciphertext', () => {
      const stored = encryptTotpSecret('JBSWY3DPEHPK3PXP');
      const parts = stored.split('.');
      parts[6] = Buffer.from('tampered-ciphertext-bytes!').toString('base64');
      expect(() => decryptTotpSecret(parts.join('.'))).toThrow();
    });
  });

  describe('backward compatibility with the pre-envelope (legacy P0) format', () => {
    it('still decrypts a legacy-format secret (iv.tag.ciphertext, no envelope)', () => {
      // Reproduce the OLD direct-encryption scheme by hand to prove the new
      // decryptTotpSecret() still understands it, without depending on the
      // old implementation still existing anywhere.
      process.env.TOTP_MASTER_KEY_CURRENT = KEY_A;
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY_A, 'base64'), iv);
      const ciphertext = Buffer.concat([cipher.update('LEGACYSECRET1234', 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      const legacyStored = [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');

      expect(decryptTotpSecret(legacyStored)).toBe('LEGACYSECRET1234');
    });

    it('legacy TOTP_MASTER_KEY env var (no _CURRENT suffix) still works for new encryptions', () => {
      delete process.env.TOTP_MASTER_KEY_CURRENT;
      process.env.TOTP_MASTER_KEY = KEY_A;
      const stored = encryptTotpSecret('JBSWY3DPEHPK3PXP');
      expect(decryptTotpSecret(stored)).toBe('JBSWY3DPEHPK3PXP');
    });
  });

  describe('master key rotation (Architecture §6: rotation re-wraps data keys, never re-issues enrolments)', () => {
    it('a secret wrapped under the outgoing key rotates to the new key WITHOUT changing the decrypted value', () => {
      process.env.TOTP_MASTER_KEY_CURRENT = KEY_A;
      delete process.env.TOTP_MASTER_KEY_PREVIOUS;
      const original = encryptTotpSecret('JBSWY3DPEHPK3PXP');

      // Begin rotation: KEY_A becomes 'previous', KEY_B becomes 'current'.
      process.env.TOTP_MASTER_KEY_PREVIOUS = KEY_A;
      process.env.TOTP_MASTER_KEY_CURRENT = KEY_B;

      // Before rotating this specific secret, it's still readable - key
      // resolution tries TOTP_MASTER_KEY_CURRENT (now KEY_B, wrong) then
      // falls back to TOTP_MASTER_KEY_PREVIOUS (KEY_A, correct).
      expect(decryptTotpSecret(original)).toBe('JBSWY3DPEHPK3PXP');

      const { value: rotated, changed } = rotateMasterKeyWrapping(original);
      expect(changed).toBe(true);

      // The SECRET CIPHERTEXT ITSELF is byte-for-byte unchanged - only the
      // wrapped data key changed. This is the whole point of envelope
      // encryption: rotation touches the small wrapped key, never the
      // secret payload.
      const originalParts = original.split('.');
      const rotatedParts = rotated.split('.');
      expect(rotatedParts[4]).toBe(originalParts[4]); // secret iv
      expect(rotatedParts[5]).toBe(originalParts[5]); // secret auth tag
      expect(rotatedParts[6]).toBe(originalParts[6]); // secret ciphertext

      // Still decrypts to the exact same plaintext after rotation.
      expect(decryptTotpSecret(rotated)).toBe('JBSWY3DPEHPK3PXP');

      // And now works even after TOTP_MASTER_KEY_PREVIOUS is removed
      // (rotation window closed) - proving it's genuinely on the new key.
      delete process.env.TOTP_MASTER_KEY_PREVIOUS;
      expect(decryptTotpSecret(rotated)).toBe('JBSWY3DPEHPK3PXP');
    });

    it('is idempotent - rotating an already-current secret is a no-op', () => {
      process.env.TOTP_MASTER_KEY_CURRENT = KEY_A;
      const stored = encryptTotpSecret('JBSWY3DPEHPK3PXP');
      const { value, changed } = rotateMasterKeyWrapping(stored);
      expect(changed).toBe(false);
      expect(value).toBe(stored);
    });

    it('leaves a legacy (pre-envelope) secret unchanged - not eligible for this rotation mechanism', () => {
      process.env.TOTP_MASTER_KEY_CURRENT = KEY_A;
      const legacy = 'aWFtYW5pdg==.dGFnZ2Vk.Y2lwaGVydGV4dA==';
      const { value, changed } = rotateMasterKeyWrapping(legacy);
      expect(changed).toBe(false);
      expect(value).toBe(legacy);
    });

    it('fails closed if TOTP_MASTER_KEY_PREVIOUS is missing but a secret still needs it (key-loss scenario, documented in totp-encryption.ts)', () => {
      process.env.TOTP_MASTER_KEY_CURRENT = KEY_A;
      const original = encryptTotpSecret('JBSWY3DPEHPK3PXP');

      // Rotate keys but forget to set TOTP_MASTER_KEY_PREVIOUS.
      process.env.TOTP_MASTER_KEY_CURRENT = KEY_B;
      delete process.env.TOTP_MASTER_KEY_PREVIOUS;

      expect(() => decryptTotpSecret(original)).toThrow(/TOTP_MASTER_KEY_PREVIOUS/);
      expect(() => rotateMasterKeyWrapping(original)).toThrow(/TOTP_MASTER_KEY_PREVIOUS/);
      // (this test's own TOTP_MASTER_KEY_PREVIOUS assertion still holds:
      // decryptTotpSecret's error message explicitly names the variable to
      // set, whether or not it was ever configured, so the operator always
      // knows exactly what to do.)
    });
  });
});
