/**
 * Minimal, dependency-free RFC-4180-ish CSV parser for the Import Framework
 * (P2 item 10). Deliberately simple (no formula EVALUATION - imported CSV
 * cell values are only ever read as plain strings/numbers, never executed,
 * so there is no formula-injection risk on the READ side the way there is
 * on export). Item 24 (Input/Output Security) constraints enforced here:
 *   - MAX_ROWS caps the number of data rows a single import can process,
 *     defending against a maliciously huge upload exhausting memory/CPU.
 *   - MAX_CELL_LENGTH caps any single cell's length, defending against a
 *     pathological single giant field.
 */
export const MAX_IMPORT_ROWS = 5000;
export const MAX_CELL_LENGTH = 10_000;

export class CsvTooLargeError extends Error {}

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"') {
          if (line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += char;
        }
      } else if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        cells.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current);
    return cells.map((c) => (c.length > MAX_CELL_LENGTH ? c.slice(0, MAX_CELL_LENGTH) : c));
  };

  const headers = parseLine(lines[0]);
  const dataLines = lines.slice(1);
  if (dataLines.length > MAX_IMPORT_ROWS) {
    throw new CsvTooLargeError(
      `Import exceeds the maximum of ${MAX_IMPORT_ROWS} rows (got ${dataLines.length}).`,
    );
  }

  const rows = dataLines.map((line) => {
    const cells = parseLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, i) => {
      row[header] = cells[i] ?? '';
    });
    return row;
  });

  return { headers, rows };
}
