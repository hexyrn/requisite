/**
 * Money helper for Requisite (item 38): every authoritative monetary value
 * is stored/computed as an integer count of MINOR UNITS (pence/cents) -
 * `INT8` columns, never NUMERIC/FLOAT - so no floating-point rounding error
 * can ever enter a total. `quantity` (item 4) is a genuinely fractional
 * NUMERIC(14,4) column (partial units, e.g. 2.5 metres, are legitimate),
 * but price/total columns are always minor-unit integers.
 */
export function multiplyMinor(unitPriceMinor: bigint, quantity: string | number): bigint {
  // Quantity may carry up to 4 decimal places (schema: NUMERIC(14,4)).
  // Scale it to an integer (x10000), multiply, then divide back down -
  // avoids ever routing a monetary calculation through IEEE-754 floats.
  const qty = typeof quantity === 'number' ? quantity.toString() : quantity;
  const [whole, frac = ''] = qty.split('.');
  const fracPadded = (frac + '0000').slice(0, 4);
  const scaledQty = BigInt(whole || '0') * 10000n + BigInt(fracPadded || '0');
  return (unitPriceMinor * scaledQty) / 10000n;
}

export function sumMinor(values: bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}

export function applyTaxRateBp(netMinor: bigint, taxRateBp: number): bigint {
  // Basis points (1/100 of a percent) - e.g. 2000 = 20.00% - kept as an
  // integer rate, never a float multiplier like 0.2.
  return (netMinor * BigInt(taxRateBp)) / 10000n;
}

/** DB round-trip helper: pg returns INT8 as a string (JS number can't safely hold all int8 values). */
export function toBigintMinor(dbValue: string | number | bigint): bigint {
  return BigInt(dbValue);
}

export function minorToDecimalString(minor: bigint): string {
  // Assumes a 2-decimal-place currency (GBP/USD/EUR) - a genuinely
  // 0-decimal or 3-decimal currency would need a per-currency exponent
  // table; deferred as documented v1 scope (single-currency-optimised UI,
  // per item 38).
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / 100n;
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${cents}`;
}
