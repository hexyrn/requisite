import { describe, expect, it } from 'vitest';
import { guessRegionDefaults, readTokenFromHash } from '../pages/regionDefaults';

describe('guessRegionDefaults', () => {
  it('derives currency and financial year from the browser locale', () => {
    expect(guessRegionDefaults('en-GB', 'Europe/London')).toEqual({
      defaultCurrency: 'GBP',
      timezone: 'Europe/London',
      locale: 'en-GB',
      financialYearStartMonth: 4,
    });
    expect(guessRegionDefaults('en-US', 'America/Chicago').defaultCurrency).toBe('USD');
  });
  it('falls back safely for unknown regions', () => {
    const d = guessRegionDefaults('xx', 'UTC');
    expect(d.defaultCurrency).toBe('USD');
    expect(d.financialYearStartMonth).toBe(1);
  });
});

describe('readTokenFromHash', () => {
  const token = 'A'.repeat(43);
  it('reads a setup code from the fragment', () => {
    expect(readTokenFromHash(`#token=${token}`)).toBe(token);
    expect(readTokenFromHash(`#x=1&token=${token}`)).toBe(token);
  });
  it('ignores missing or malformed codes', () => {
    expect(readTokenFromHash('')).toBe('');
    expect(readTokenFromHash('#token=short')).toBe('');
    expect(readTokenFromHash('#token=<script>alert(1)</script>aaaaaaaaaaaaaaaaaaaa')).toBe('');
  });
});
