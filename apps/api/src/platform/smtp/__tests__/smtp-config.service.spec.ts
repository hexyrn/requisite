import { Pool } from 'pg';
import { setUpTestDatabase } from '../../../test-utils/test-db';
import { attachPoolErrorHandler } from '../../../db/pool';
import { SmtpConfigService } from '../smtp-config.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('SmtpConfigService (P3 item 9/24) - secure credential handling', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 3 }));
    await setUpTestDatabase(pool);
    await pool.query(`INSERT INTO installations (core_version) VALUES ('0.1.0-test')`);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  const CANARY_PASSWORD = 'CANARY-SMTP-PASSWORD-qR8tY3uI6oP1';

  it('returns configured: false before anything is set', async () => {
    const service = new SmtpConfigService();
    const display = await service.getConfigForDisplay(pool);
    expect(display.configured).toBe(false);
    expect(display.passwordSet).toBe(false);
  });

  it('stores a real config with an encrypted password, and getConfigForDisplay NEVER returns the password or its ciphertext', async () => {
    const service = new SmtpConfigService();
    await service.setConfig(pool, {
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: 'notifications@example.com',
      password: CANARY_PASSWORD,
      fromAddress: 'hexyrn@example.com',
    });

    const display = await service.getConfigForDisplay(pool);
    expect(display.configured).toBe(true);
    expect(display.host).toBe('smtp.example.com');
    expect(display.port).toBe(587);
    expect(display.username).toBe('notifications@example.com');
    expect(display.passwordSet).toBe(true);
    expect(JSON.stringify(display)).not.toContain(CANARY_PASSWORD);
    // `passwordSet` (a legitimate boolean flag name) is expected to appear -
    // what must NOT appear is a `password` VALUE/ciphertext field.
    expect(display).not.toHaveProperty('password');
    expect(display).not.toHaveProperty('passwordEncrypted');
  });

  it('the raw installations.config column never contains the password in plaintext either (defense in depth, not just the display layer)', async () => {
    const service = new SmtpConfigService();
    await service.setConfig(pool, {
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: 'notifications@example.com',
      password: CANARY_PASSWORD,
      fromAddress: 'hexyrn@example.com',
    });

    const raw = await pool.query<{ config: unknown }>('SELECT config FROM installations LIMIT 1');
    expect(JSON.stringify(raw.rows[0].config)).not.toContain(CANARY_PASSWORD);
  });

  it('getConfigForSending decrypts the password correctly for actual delivery use (round trip)', async () => {
    const service = new SmtpConfigService();
    await service.setConfig(pool, {
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: 'notifications@example.com',
      password: CANARY_PASSWORD,
      fromAddress: 'hexyrn@example.com',
    });

    const forSending = await service.getConfigForSending(pool);
    expect(forSending?.password).toBe(CANARY_PASSWORD); // the ONE place the plaintext is legitimately available - for actually connecting to the SMTP server
  });

  it('clearConfig removes the configuration entirely', async () => {
    const service = new SmtpConfigService();
    await service.setConfig(pool, {
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: null,
      password: null,
      fromAddress: 'hexyrn@example.com',
    });
    await service.clearConfig(pool);
    const display = await service.getConfigForDisplay(pool);
    expect(display.configured).toBe(false);
  });

  it('updating the host/port does not require re-entering the password (SmtpController.keepExistingPassword behaviour is exercised at the config-service level here via direct getConfigForSending re-use)', async () => {
    const service = new SmtpConfigService();
    await service.setConfig(pool, {
      host: 'old-host.example.com',
      port: 587,
      secure: false,
      username: 'u',
      password: CANARY_PASSWORD,
      fromAddress: 'hexyrn@example.com',
    });

    // Simulate the controller's "blank password means keep existing" logic directly against the service.
    const existing = await service.getConfigForSending(pool);
    await service.setConfig(pool, {
      host: 'new-host.example.com',
      port: 587,
      secure: false,
      username: 'u',
      password: existing!.password,
      fromAddress: 'hexyrn@example.com',
    });

    const afterUpdate = await service.getConfigForSending(pool);
    expect(afterUpdate?.host).toBe('new-host.example.com');
    expect(afterUpdate?.password).toBe(CANARY_PASSWORD); // survived the host-only update
  });
});
