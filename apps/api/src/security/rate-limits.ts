import { HttpException, HttpStatus } from '@nestjs/common';
import { AccountRateLimiter } from './account-rate-limiter';

/**
 * Named rate limiters for every sensitive P0 endpoint, per two independent
 * dimensions - account/identity-keyed and IP/source-keyed - as required.
 * Each endpoint gets its own pair of limiter instances so exhausting one
 * endpoint's budget never affects another's, and an attacker must be
 * blocked on BOTH dimensions to get through (blocked on either fails the
 * request). Windows/thresholds are deliberately generous enough not to
 * lock out real users under normal typos, tight enough to blunt scripted
 * brute-forcing.
 */
const FIFTEEN_MIN = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

export const loginRateLimiters = {
  byAccount: new AccountRateLimiter(10, FIFTEEN_MIN), // on top of AuthService's own 5-attempt lockout
  byIp: new AccountRateLimiter(30, FIFTEEN_MIN),
};

export const passwordResetRequestRateLimiters = {
  byAccount: new AccountRateLimiter(5, ONE_HOUR),
  byIp: new AccountRateLimiter(20, ONE_HOUR),
};

export const passwordResetSubmitRateLimiters = {
  byAccount: new AccountRateLimiter(10, ONE_HOUR), // keyed by the token itself - see controller
  byIp: new AccountRateLimiter(30, ONE_HOUR),
};

export const invitationAcceptRateLimiters = {
  byAccount: new AccountRateLimiter(10, ONE_HOUR), // keyed by the token itself
  byIp: new AccountRateLimiter(30, ONE_HOUR),
};

export const bootstrapRateLimiters = {
  byIp: new AccountRateLimiter(10, ONE_HOUR),
};

export const mfaVerifyRateLimiters = {
  byAccount: new AccountRateLimiter(10, FIFTEEN_MIN),
  byIp: new AccountRateLimiter(30, FIFTEEN_MIN),
};

/**
 * Checks both dimensions and throws 429 if either is exhausted. Call this
 * BEFORE doing any real work (password verification, DB writes) so a
 * rate-limited caller never even reaches the expensive/sensitive path.
 */
export function enforceRateLimit(
  limiters: { byAccount?: AccountRateLimiter; byIp?: AccountRateLimiter },
  accountKey: string | null,
  ipKey: string,
): void {
  if (limiters.byIp && !limiters.byIp.consume(ipKey)) {
    throw new HttpException('Too many requests. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
  }
  if (limiters.byAccount && accountKey && !limiters.byAccount.consume(accountKey)) {
    throw new HttpException('Too many requests. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
  }
}
