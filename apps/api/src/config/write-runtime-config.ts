/**
 * Called by the Windows installer's provisioning step (with the bundled node.exe):
 *   node write-runtime-config.js --credentials <database.env> --licence-key-file <file>
 *        --install-dir <dir> --data-dir <dir> [--pg-port 55432] [--web-port 3000] --out <hexyrn.env>
 * Writes the settings file the service reads at startup. Refuses to overwrite an existing file,
 * so a repair/upgrade never regenerates (and thereby invalidates) an installation's secrets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { buildRuntimeConfig } from './runtime-config';

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i] ?? '';
  }
  return out;
}

function main(): void {
  const f = flags(process.argv.slice(2));
  const need = (k: string) => {
    if (!f[k]) throw new Error(`missing --${k}`);
    return f[k];
  };
  const out = need('out');
  if (existsSync(out)) {
    console.log(`${out} already exists - leaving it untouched.`);
    return;
  }
  const text = buildRuntimeConfig({
    credentialsText: readFileSync(need('credentials'), 'utf8'),
    licencePublicKey: readFileSync(need('licence-key-file'), 'utf8'),
    installDir: need('install-dir'),
    dataDir: need('data-dir'),
    pgPort: Number(f['pg-port'] ?? '55432'),
    webPort: Number(f['web-port'] ?? '3000'),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text, { mode: 0o600 });
  console.log(`Wrote ${out}`);
}

try {
  main();
} catch (e) {
  console.error(`write-runtime-config: ${(e as Error).message}`);
  process.exit(1);
}
