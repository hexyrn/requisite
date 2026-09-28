/**
 * Sensible starting values for the organisation's regional settings, taken from the browser, so the
 * first-run wizard only has to ask what only the customer knows (name, owner email, password).
 * All of these remain editable under "Regional settings".
 */
export interface RegionDefaults {
  defaultCurrency: string;
  timezone: string;
  locale: string;
  financialYearStartMonth: number;
}

const CURRENCY_BY_REGION: Record<string, string> = {
  GB: 'GBP',
  US: 'USD',
  CA: 'CAD',
  AU: 'AUD',
  NZ: 'NZD',
  IE: 'EUR',
  DE: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  AT: 'EUR',
  PT: 'EUR',
  FI: 'EUR',
  GR: 'EUR',
  ZA: 'ZAR',
  IN: 'INR',
  CH: 'CHF',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  JP: 'JPY',
  SG: 'SGD',
  AE: 'AED',
};

/** Financial year conventions that differ from January-December (start month, 1-12). */
const FY_START_BY_REGION: Record<string, number> = { GB: 4, IN: 4, AU: 7, NZ: 4, ZA: 3, JP: 4 };

export const COMMON_CURRENCIES = [
  'GBP',
  'USD',
  'EUR',
  'CAD',
  'AUD',
  'NZD',
  'ZAR',
  'INR',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'JPY',
  'SGD',
  'AED',
];

export function guessRegionDefaults(
  locale: string = typeof navigator !== 'undefined' ? navigator.language : 'en-US',
  timezone: string = safeTimezone(),
): RegionDefaults {
  const region = /[-_]([A-Za-z]{2})\b/.exec(locale)?.[1]?.toUpperCase();
  return {
    defaultCurrency: (region && CURRENCY_BY_REGION[region]) || 'USD',
    timezone,
    locale: locale || 'en-US',
    financialYearStartMonth: (region && FY_START_BY_REGION[region]) || 1,
  };
}

function safeTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Reads a one-time setup code passed in the URL fragment (#token=...), which is never sent to the server. */
export function readTokenFromHash(hash: string): string {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]{20,200})(?:&|$)/.exec(hash);
  return match ? match[1] : '';
}
