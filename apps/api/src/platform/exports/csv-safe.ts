/**
 * CSV/XLSX formula-injection defense. P2 items 10/24. A cell value
 * beginning with `=`, `+`, `-`, `@`, tab, or carriage-return is
 * interpreted as a FORMULA by Excel/LibreOffice/Google Sheets when the
 * file is opened - a malicious value like `=cmd|'/c calc'!A1` can achieve
 * code execution in the recipient's spreadsheet application. Prefixing
 * such values with a single quote neutralises this (both CSV and XLSX
 * writers treat the leading quote as "this is text"), while leaving
 * genuinely numeric/plain-text values untouched.
 */
const DANGEROUS_PREFIX_RE = /^[=+\-@\t\r]/;

export function sanitizeForSpreadsheet(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return DANGEROUS_PREFIX_RE.test(str) ? `'${str}` : str;
}

/** Minimal RFC 4180 CSV cell escaping, applied AFTER formula-injection sanitisation. */
export function csvCell(value: unknown): string {
  const safe = sanitizeForSpreadsheet(value);
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const header = columns.map((c) => csvCell(c)).join(',');
  const body = rows.map((row) => columns.map((c) => csvCell(row[c])).join(',')).join('\r\n');
  return `${header}\r\n${body}`;
}
