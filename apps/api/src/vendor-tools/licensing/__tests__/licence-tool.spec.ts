import {
  generateLicenceKeypair,
  issueLicence,
  publicKeyEnvValueFromPrivate,
} from '../licence-tool';
import { LicenseVerifier } from '../../../platform/licensing/license-verifier';
import { normalizePublicKeyPem } from '../../../platform/licensing/keys';

const ORG = '5b0d6a52-3b6f-4c58-9d0e-0c5a1e7a9f10';
const APP = 'com.hexyrn.requisite';

describe('licence tool - the vendor workflow, verified against the real verifier', () => {
  const original = process.env.HEXYRN_LICENSE_PUBLIC_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.HEXYRN_LICENSE_PUBLIC_KEY;
    else process.env.HEXYRN_LICENSE_PUBLIC_KEY = original;
  });

  const keys = generateLicenceKeypair();
  const licence = issueLicence({
    privateKeyPem: keys.privateKeyPem,
    appId: APP,
    organisationId: ORG,
    majorVersion: 1,
    supportExpiresAt: null,
  });
  const verify = (l = licence, org = ORG) =>
    new LicenseVerifier().verify(l, { appId: APP, organisationId: org, majorVersion: 1 });

  it.each([
    ['single-line base64 (what keygen prints)', () => keys.publicKeyEnvValue],
    ['full multi-line PEM', () => keys.publicKeyPem],
    [
      'PEM with literal \\n sequences (single-line .env)',
      () => keys.publicKeyPem.trim().replace(/\n/g, '\\n'),
    ],
    ['quoted value', () => `"${keys.publicKeyEnvValue}"`],
  ])(
    'a licence issued by the tool verifies when the public key is supplied as: %s',
    (_n, value) => {
      process.env.HEXYRN_LICENSE_PUBLIC_KEY = value();
      expect(verify()).toEqual({ valid: true });
    },
  );

  it('rejects a licence for a different organisation, a tampered payload, and a licence signed by another key', () => {
    process.env.HEXYRN_LICENSE_PUBLIC_KEY = keys.publicKeyEnvValue;
    expect(verify(licence, '11111111-1111-4111-8111-111111111111').valid).toBe(false);
    expect(verify({ ...licence, majorVersion: 2 }).valid).toBe(false);
    const rogue = generateLicenceKeypair();
    const forged = issueLicence({
      privateKeyPem: rogue.privateKeyPem,
      appId: APP,
      organisationId: ORG,
      majorVersion: 1,
      supportExpiresAt: null,
    });
    expect(verify(forged).valid).toBe(false);
  });

  it('pubkey re-derives exactly the value keygen printed', () => {
    expect(publicKeyEnvValueFromPrivate(keys.privateKeyPem)).toBe(keys.publicKeyEnvValue);
  });

  it('records the support expiry as a real ISO date and validates inputs', () => {
    const l = issueLicence({
      privateKeyPem: keys.privateKeyPem,
      appId: APP,
      organisationId: ORG,
      majorVersion: 1,
      supportExpiresAt: '2027-09-28',
    });
    expect(l.supportExpiresAt).toBe('2027-09-28T00:00:00.000Z');
    const base = {
      privateKeyPem: keys.privateKeyPem,
      appId: APP,
      majorVersion: 1,
      supportExpiresAt: null,
    };
    expect(() => issueLicence({ ...base, organisationId: 'not-a-uuid' })).toThrow(/UUID/);
    expect(() => issueLicence({ ...base, organisationId: ORG, majorVersion: 0 })).toThrow(
      /major version/,
    );
    expect(() => issueLicence({ ...base, organisationId: ORG, supportExpiresAt: 'soon' })).toThrow(
      /valid date/,
    );
  });

  it('normalizePublicKeyPem leaves an already-correct PEM untouched', () => {
    expect(normalizePublicKeyPem(keys.publicKeyPem)).toBe(keys.publicKeyPem.trim());
  });
});
