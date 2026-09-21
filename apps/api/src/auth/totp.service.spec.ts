import { authenticator } from 'otplib';
import { TotpService } from './totp.service';
import { encryptTotpSecret, decryptTotpSecret } from '../security/totp-encryption';

describe('TotpService (RFC 6238, no DB required)', () => {
  const service = new TotpService();

  beforeAll(() => {
    process.env.TOTP_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  });

  it('generates a secret and otpauth URL on enrolment', () => {
    const { secret, otpauthUrl } = service.beginEnrolment('user@test.local');
    expect(secret).toMatch(/^[A-Z2-7]+$/); // base32
    expect(otpauthUrl).toContain('otpauth://totp/');
  });

  it('verifies a correctly generated current code', () => {
    const { secret } = service.beginEnrolment('user@test.local');
    const code = authenticator.generate(secret);
    expect(service.verifyCode(secret, code)).toBe(true);
  });

  it('rejects an incorrect code', () => {
    const { secret } = service.beginEnrolment('user@test.local');
    expect(service.verifyCode(secret, '000000')).toBe(false);
  });

  it('encrypts and decrypts a TOTP secret at rest (P0 simplified single-master-key scheme)', () => {
    const secret = authenticator.generateSecret();
    const encrypted = encryptTotpSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptTotpSecret(encrypted)).toBe(secret);
  });

  it('fails to decrypt with a tampered ciphertext (AEAD integrity check)', () => {
    const secret = authenticator.generateSecret();
    const encrypted = encryptTotpSecret(secret);
    const parts = encrypted.split('.');
    parts[2] = Buffer.from('tampered-ciphertext-bytes!!').toString('base64');
    expect(() => decryptTotpSecret(parts.join('.'))).toThrow();
  });
});
