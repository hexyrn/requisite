import { AccountRateLimiter } from './account-rate-limiter';

describe('AccountRateLimiter', () => {
  it('allows up to maxAttempts within the window, then blocks', () => {
    const limiter = new AccountRateLimiter(3, 60_000);
    expect(limiter.consume('a@test.local')).toBe(true);
    expect(limiter.consume('a@test.local')).toBe(true);
    expect(limiter.consume('a@test.local')).toBe(true);
    expect(limiter.consume('a@test.local')).toBe(false);
  });

  it('tracks keys independently', () => {
    const limiter = new AccountRateLimiter(1, 60_000);
    expect(limiter.consume('a@test.local')).toBe(true);
    expect(limiter.consume('b@test.local')).toBe(true);
    expect(limiter.consume('a@test.local')).toBe(false);
    expect(limiter.consume('b@test.local')).toBe(false);
  });

  it('allows again once the window has passed', async () => {
    const limiter = new AccountRateLimiter(1, 20);
    expect(limiter.consume('a@test.local')).toBe(true);
    expect(limiter.consume('a@test.local')).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(limiter.consume('a@test.local')).toBe(true);
  });

  it('reset() clears a key immediately', () => {
    const limiter = new AccountRateLimiter(1, 60_000);
    expect(limiter.consume('a@test.local')).toBe(true);
    limiter.reset('a@test.local');
    expect(limiter.consume('a@test.local')).toBe(true);
  });

  it('sweep() removes fully-expired keys', async () => {
    const limiter = new AccountRateLimiter(1, 15);
    limiter.consume('a@test.local');
    await new Promise((r) => setTimeout(r, 25));
    limiter.sweep();
    expect(limiter.consume('a@test.local')).toBe(true);
  });
});
