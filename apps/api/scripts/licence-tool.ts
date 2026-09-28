/**
 * Vendor licence tool.
 *
 *   npm run licence --workspace apps/api -- keygen  --out ./licence-keys
 *   npm run licence --workspace apps/api -- issue   --key ./licence-keys/licence-private.pem \
 *        --org <organisation-uuid> [--app com.hexyrn.requisite] [--major 1] \
 *        [--support-expires 2027-09-28] [--out customer.licence]
 *   npm run licence --workspace apps/api -- pubkey  --key ./licence-keys/licence-private.pem
 *
 * keygen : create the signing keypair ONCE. Keep the private key offline.
 *          Put the printed HEXYRN_LICENSE_PUBLIC_KEY value in the deployment's .env.
 * issue  : sign a licence for one organisation. The output file is exactly what
 *          Administration > Licence expects pasted in.
 * pubkey : re-print the HEXYRN_LICENSE_PUBLIC_KEY value for an existing private key.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  generateLicenceKeypair,
  issueLicence,
  publicKeyEnvValueFromPrivate,
} from '../src/platform/licensing/licence-tool';

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--'))
      flags[a.slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : 'true';
  }
  return { command, flags };
}

function need(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v || v === 'true') throw new Error(`missing --${name}`);
  return v;
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'keygen': {
      const dir = flags.out && flags.out !== 'true' ? flags.out : './licence-keys';
      const privPath = join(dir, 'licence-private.pem');
      if (existsSync(privPath)) {
        throw new Error(
          `${privPath} already exists - refusing to overwrite a signing key. Move it first if you really want a new one.`,
        );
      }
      mkdirSync(dir, { recursive: true });
      const k = generateLicenceKeypair();
      writeFileSync(privPath, k.privateKeyPem, { mode: 0o600 });
      writeFileSync(join(dir, 'licence-public.pem'), k.publicKeyPem);
      console.log(`Private key (KEEP OFFLINE, never deploy or commit): ${privPath}`);
      console.log(`Public key: ${join(dir, 'licence-public.pem')}\n`);
      console.log('Add this line to the deployment .env:\n');
      console.log(`HEXYRN_LICENSE_PUBLIC_KEY=${k.publicKeyEnvValue}`);
      break;
    }
    case 'pubkey': {
      console.log(
        `HEXYRN_LICENSE_PUBLIC_KEY=${publicKeyEnvValueFromPrivate(readFileSync(need(flags, 'key'), 'utf8'))}`,
      );
      break;
    }
    case 'issue': {
      const licence = issueLicence({
        privateKeyPem: readFileSync(need(flags, 'key'), 'utf8'),
        organisationId: need(flags, 'org'),
        appId: flags.app ?? 'com.hexyrn.requisite',
        majorVersion: Number(flags.major ?? '1'),
        supportExpiresAt: flags['support-expires'] ?? null,
      });
      const out = flags.out ?? `${licence.organisationId}.licence`;
      writeFileSync(out, JSON.stringify(licence, null, 2) + '\n');
      console.log(`Licence written to ${out}`);
      console.log(
        `  app ${licence.appId}, major version ${licence.majorVersion}, ` +
          (licence.supportExpiresAt
            ? `support until ${licence.supportExpiresAt}`
            : 'perpetual support'),
      );
      console.log('Send this file to the customer; they paste it into Administration > Licence.');
      break;
    }
    default:
      console.log(
        'Usage: licence-tool <keygen|issue|pubkey> [options] - see the header of scripts/licence-tool.ts',
      );
      process.exitCode = command === 'help' ? 0 : 1;
  }
}

try {
  main();
} catch (e) {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
}
