import { hashPassword, verifyPassword } from './passwords';

describe('passwords (Argon2id)', () => {
  it('hashes with the argon2id variant', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('verifies a correct password and rejects an incorrect one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'wrong password')).toBe(false);
  });

  it('never returns the plaintext anywhere in the hash', async () => {
    const plain = 'super-secret-value-123';
    const hash = await hashPassword(plain);
    expect(hash).not.toContain(plain);
  });
});
