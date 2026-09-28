import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * Licence architecture (hard requirement): a CUSTOMER INSTALLATION must never contain Hexyrn's licence
 * private key - nor any code able to sign a licence. Hexyrn signs; the customer install only verifies.
 *
 * The compiled application is `tsc` over src/ minus tsconfig.json "exclude". These tests fail if
 * anything that could sign, or any private-key material, is reachable from what actually ships.
 */
const SRC = join(__dirname, '..', '..', '..');
const API_ROOT = join(SRC, '..');
const tsconfig = JSON.parse(readFileSync(join(API_ROOT, 'tsconfig.json'), 'utf8')) as {
  exclude: string[];
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Mirrors the tsconfig excludes that matter here: specs, test-utils and vendor-tools never ship. */
function isShipped(file: string): boolean {
  const rel = relative(SRC, file).split(sep).join('/');
  return (
    !rel.endsWith('.spec.ts') &&
    !rel.startsWith('test-utils/') &&
    !rel.startsWith('vendor-tools/') &&
    !rel.includes('/__tests__/')
  );
}

describe('customer builds contain no licence-signing capability', () => {
  it('tsconfig excludes vendor-tools (signing code + test private key) from the compiled application', () => {
    expect(tsconfig.exclude).toEqual(expect.arrayContaining(['src/vendor-tools/**']));
    expect(existsSync(join(SRC, 'vendor-tools', 'licensing', 'license-signer.ts'))).toBe(true);
  });

  it('no shipped source file contains private-key material', () => {
    const offenders = walk(SRC)
      .filter(isShipped)
      .filter((f) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('no shipped source file can sign a licence or imports the vendor-only code', () => {
    const offenders = walk(SRC)
      .filter(isShipped)
      .filter((f) => {
        const text = readFileSync(f, 'utf8');
        // real imports / construction only - comments may mention these names
        return /(from\s+|import\(\s*|require\(\s*)['"][^'"]*(vendor-tools|license-signer|licence-tool)['"]|new\s+LicenseSigner\(|class\s+LicenseSigner\b/.test(
          text,
        );
      })
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('the old locations of the signer and tool are gone (a stale copy would still be compiled and shipped)', () => {
    expect(existsSync(join(SRC, 'platform', 'licensing', 'license-signer.ts'))).toBe(false);
    expect(existsSync(join(SRC, 'platform', 'licensing', 'licence-tool.ts'))).toBe(false);
  });
});
