import { checkProductionConfig, assertProductionConfigOrThrow } from '../production-config-check';

const VALID_ENV = {
  NODE_ENV: 'production',
  TOTP_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
  HEXYRN_LICENSE_PUBLIC_KEY: 'some-real-configured-key',
  COOKIE_SECURE: 'true',
  DATABASE_URL: 'postgres://hexyrn_app:x@db:5432/hexyrn_core',
} as unknown as NodeJS.ProcessEnv;

describe('production-config-check (P3 item 39)', () => {
  it('is a no-op outside production - dev/test convenience defaults are allowed', () => {
    expect(checkProductionConfig({ NODE_ENV: 'development' } as any)).toEqual([]);
    expect(checkProductionConfig({} as any)).toEqual([]); // NODE_ENV unset - matches every existing dev/test script
  });

  it('passes with a fully valid production configuration', () => {
    expect(checkProductionConfig(VALID_ENV)).toEqual([]);
  });

  it('flags a missing TOTP_MASTER_KEY', () => {
    const env = { ...VALID_ENV, TOTP_MASTER_KEY: undefined };
    const issues = checkProductionConfig(env as any);
    expect(issues.map((i) => i.variable)).toContain('TOTP_MASTER_KEY');
  });

  it('flags a TOTP_MASTER_KEY of the wrong length', () => {
    const env = { ...VALID_ENV, TOTP_MASTER_KEY: Buffer.alloc(16, 1).toString('base64') };
    const issues = checkProductionConfig(env as any);
    expect(issues.map((i) => i.variable)).toContain('TOTP_MASTER_KEY');
  });

  it('flags a missing HEXYRN_LICENSE_PUBLIC_KEY (would silently trust the committed test key otherwise)', () => {
    const env = { ...VALID_ENV, HEXYRN_LICENSE_PUBLIC_KEY: undefined };
    const issues = checkProductionConfig(env as any);
    expect(issues.map((i) => i.variable)).toContain('HEXYRN_LICENSE_PUBLIC_KEY');
  });

  it("flags COOKIE_SECURE='false' in production", () => {
    const env = { ...VALID_ENV, COOKIE_SECURE: 'false' };
    const issues = checkProductionConfig(env as any);
    expect(issues.map((i) => i.variable)).toContain('COOKIE_SECURE');
  });

  it('flags a missing DATABASE_URL', () => {
    const env = { ...VALID_ENV, DATABASE_URL: undefined };
    const issues = checkProductionConfig(env as any);
    expect(issues.map((i) => i.variable)).toContain('DATABASE_URL');
  });

  it('collects multiple issues at once rather than stopping at the first', () => {
    // COOKIE_SECURE is intentionally not flagged when merely unset (only an
    // explicit 'false' is a problem - see checkProductionConfig), so an
    // otherwise-empty production env still surfaces the other 3.
    const env = { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv;
    const issues = checkProductionConfig(env);
    expect(issues.map((i) => i.variable).sort()).toEqual(
      ['DATABASE_URL', 'HEXYRN_LICENSE_PUBLIC_KEY', 'TOTP_MASTER_KEY'].sort(),
    );
  });

  describe('assertProductionConfigOrThrow', () => {
    it('does not throw for a valid production config', () => {
      expect(() => assertProductionConfigOrThrow(VALID_ENV)).not.toThrow();
    });

    it('does not throw outside production regardless of missing secrets', () => {
      expect(() => assertProductionConfigOrThrow({} as any)).not.toThrow();
    });

    it('throws a single readable error naming every missing variable', () => {
      const env = { NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv;
      expect(() => assertProductionConfigOrThrow(env)).toThrow(/TOTP_MASTER_KEY/);
      expect(() => assertProductionConfigOrThrow(env)).toThrow(/HEXYRN_LICENSE_PUBLIC_KEY/);
      expect(() => assertProductionConfigOrThrow(env)).toThrow(/DATABASE_URL/);
    });
  });
});
