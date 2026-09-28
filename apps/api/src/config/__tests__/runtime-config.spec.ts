import * as path from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildRuntimeConfig } from '../runtime-config';
import { parseEnvFile, loadEnvFile } from '../env-file';
import { checkProductionConfig } from '../production-config-check';
import { getConfiguredPublicKey } from '../../platform/licensing/keys';
import { generateLicenceKeypair, issueLicence } from '../../platform/licensing/licence-tool';
import { LicenseVerifier } from '../../platform/licensing/license-verifier';

const CREDS = [
  'TOTP_MASTER_KEY_CURRENT=' + Buffer.alloc(32, 1).toString('base64'),
  'SECRET_ENCRYPTION_MASTER_KEY=' + Buffer.alloc(32, 2).toString('base64'),
  'HEXYRN_SESSION_SECRET=' + Buffer.alloc(48, 3).toString('base64'),
  'HEXYRN_MIGRATE_DB_PASSWORD=migrate_pw-1',
  'HEXYRN_APP_DB_PASSWORD=app_pw-2',
  'HEXYRN_BACKUP_DB_PASSWORD=backup_pw-3',
].join('\r\n');

const keys = generateLicenceKeypair();
const input = {
  credentialsText: CREDS,
  licencePublicKey: keys.publicKeyEnvValue + '\r\n',
  installDir: 'C:\\Program Files\\Hexyrn Core',
  dataDir: 'C:\\ProgramData\\Hexyrn Core',
  pgPort: 55432,
  webPort: 3000,
};

describe('Windows runtime config (what makes an installed copy start)', () => {
  const text = buildRuntimeConfig(input, path.win32);
  const cfg = parseEnvFile(text);

  it('produces a configuration the production startup guard accepts', () => {
    expect(checkProductionConfig(cfg as any)).toEqual([]);
  });

  it('uses least-privilege database roles, loopback binding and the right Windows paths', () => {
    expect(cfg.HOST).toBe('127.0.0.1');
    expect(cfg.DATABASE_URL).toBe('postgres://hexyrn_app:app_pw-2@127.0.0.1:55432/hexyrn_core');
    expect(cfg.BACKUP_DATABASE_URL).toContain('hexyrn_backup:backup_pw-3@');
    expect(cfg.MIGRATE_DATABASE_URL).toContain('hexyrn:migrate_pw-1@');
    expect(cfg.HEXYRN_WEB_DIR).toBe('C:\\Program Files\\Hexyrn Core\\api\\apps\\web\\dist');
    expect(cfg.PG_DUMP_PATH).toBe('C:\\Program Files\\Hexyrn Core\\postgresql\\bin\\pg_dump.exe');
    expect(cfg.HEXYRN_BOOTSTRAP_TOKEN_FILE).toBe(
      'C:\\ProgramData\\Hexyrn Core\\config\\bootstrap-token.txt',
    );
    expect(cfg.ALLOWED_ORIGINS).toBe('http://localhost:3000,http://127.0.0.1:3000');
    expect(cfg.COOKIE_SECURE).toBe('true');
  });

  it('is loaded by the same env-file loader the service uses, and the embedded licence key really verifies a vendor licence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hx-cfg-'));
    const file = join(dir, 'hexyrn.env');
    writeFileSync(file, text);
    const env: NodeJS.ProcessEnv = { HEXYRN_ENV_FILE: file };
    loadEnvFile(env, 'linux');
    const before = process.env.HEXYRN_LICENSE_PUBLIC_KEY;
    process.env.HEXYRN_LICENSE_PUBLIC_KEY = env.HEXYRN_LICENSE_PUBLIC_KEY;
    try {
      expect(getConfiguredPublicKey()).toContain('BEGIN PUBLIC KEY');
      const orgId = '5b0d6a52-3b6f-4c58-9d0e-0c5a1e7a9f10';
      const licence = issueLicence({
        privateKeyPem: keys.privateKeyPem,
        appId: 'com.hexyrn.requisite',
        organisationId: orgId,
        majorVersion: 1,
        supportExpiresAt: null,
      });
      expect(
        new LicenseVerifier().verify(licence, {
          appId: 'com.hexyrn.requisite',
          organisationId: orgId,
          majorVersion: 1,
        }),
      ).toEqual({ valid: true });
    } finally {
      if (before === undefined) delete process.env.HEXYRN_LICENSE_PUBLIC_KEY;
      else process.env.HEXYRN_LICENSE_PUBLIC_KEY = before;
    }
  });

  it('refuses incomplete or unsafe input rather than writing a config that would fail later', () => {
    expect(() =>
      buildRuntimeConfig(
        { ...input, credentialsText: CREDS.replace(/SECRET_ENCRYPTION_MASTER_KEY=.*\r\n/, '') },
        path.win32,
      ),
    ).toThrow(/SECRET_ENCRYPTION_MASTER_KEY/);
    expect(() =>
      buildRuntimeConfig(
        { ...input, credentialsText: CREDS.replace('app_pw-2', 'bad/pw@x') },
        path.win32,
      ),
    ).toThrow(/URL-safe/);
    expect(() => buildRuntimeConfig({ ...input, licencePublicKey: '  \r\n' }, path.win32)).toThrow(
      /licence public key/,
    );
    expect(() => buildRuntimeConfig({ ...input, webPort: 0 }, path.win32)).toThrow(/port/);
  });
});
