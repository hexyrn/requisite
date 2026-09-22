import React from 'react';

/**
 * Renders an authoritative minor-unit monetary value (bigint-as-string,
 * e.g. from Requisite's INT8 minor-unit columns) as a readable currency
 * string. Formatting-only - the DISPLAY conversion here is never used for
 * any calculation; the backend remains the sole source of truth for every
 * monetary total (item 6/38's "no floating-point for authoritative
 * values" - this component only ever receives already-computed values,
 * never computes one).
 */
export interface MoneyProps {
  minorUnits: string | number | bigint;
  currency?: string;
}

export function Money({ minorUnits, currency = 'GBP' }: MoneyProps) {
  let formatted: string;
  try {
    const minor = BigInt(minorUnits);
    const negative = minor < 0n;
    const abs = negative ? -minor : minor;
    const whole = abs / 100n;
    const cents = (abs % 100n).toString().padStart(2, '0');
    const wholeWithSeparators = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    formatted = `${negative ? '-' : ''}${wholeWithSeparators}.${cents}`;
  } catch {
    formatted = String(minorUnits);
  }
  const symbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {symbol}
      {formatted}
    </span>
  );
}
