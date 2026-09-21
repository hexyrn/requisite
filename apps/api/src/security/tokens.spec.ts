import { generateSecureToken, hashToken, verifyTokenHash, generateNumericRecoveryCode } from './tokens';

describe('tokens', () => {
  it('generates high-entropy, non-repeating tokens', () => {
    const a = generateSecureToken();
    const b = generateSecureToken();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThan(30);
  });

  it('hashes deterministically and verifies correctly', () => {
    const token = generateSecureToken();
    const hash = hashToken(token);
    expect(verifyTokenHash(token, hash)).toBe(true);
    expect(verifyTokenHash('wrong-token', hash)).toBe(false);
  });

  it('recovery codes are 10 digits', () => {
    const code = generateNumericRecoveryCode();
    expect(code).toMatch(/^\d{10}$/);
  });
});
