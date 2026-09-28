import { generateKeyPairSync, createPublicKey } from 'crypto';
import { LicenseSigner } from './license-signer';
import type { SignedLicense } from '../../platform/licensing/license-payload';

/**
 * Logic behind Hexyrn's licence tool (`npm run licence`, apps/api/scripts/licence-tool.ts): generate
 * the licence signing keypair once, and issue signed licences for customer organisations.
 *
 * VENDOR-ONLY: this directory is excluded from the compiled application (see tsconfig.json), so a
 * customer installation contains neither this code nor any private key. The PRIVATE key is Hexyrn's
 * root of trust - keep it offline, never in a deployment, never in git.
 */
export interface GeneratedKeypair {
  privateKeyPem: string;
  publicKeyPem: string;
  /** Single-line value for HEXYRN_LICENSE_PUBLIC_KEY (base64 SPKI body, no PEM armour). */
  publicKeyEnvValue: string;
}

export function generateLicenceKeypair(): GeneratedKeypair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKeyPem, publicKeyPem, publicKeyEnvValue: publicKeyToEnvValue(publicKeyPem) };
}

export function publicKeyToEnvValue(publicKeyPem: string): string {
  return publicKeyPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
}

/** Derives the public key from a private key file, so the env value can be re-printed later. */
export function publicKeyEnvValueFromPrivate(privateKeyPem: string): string {
  const publicPem = createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' });
  return publicKeyToEnvValue(publicPem.toString());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IssueInput {
  privateKeyPem: string;
  appId: string;
  organisationId: string;
  majorVersion: number;
  /** ISO date-time when support/updates end, or null for perpetual support. Never a kill switch (Architecture §9). */
  supportExpiresAt: string | null;
}

export function issueLicence(input: IssueInput): SignedLicense {
  if (!UUID.test(input.organisationId)) {
    throw new Error(
      `organisation id "${input.organisationId}" is not a UUID - copy it from Administration > Licence in the customer's installation.`,
    );
  }
  if (!Number.isInteger(input.majorVersion) || input.majorVersion < 1) {
    throw new Error('major version must be a positive whole number.');
  }
  if (input.supportExpiresAt !== null && Number.isNaN(Date.parse(input.supportExpiresAt))) {
    throw new Error(`support expiry "${input.supportExpiresAt}" is not a valid date.`);
  }
  return new LicenseSigner(input.privateKeyPem).issue({
    appId: input.appId,
    organisationId: input.organisationId,
    majorVersion: input.majorVersion,
    supportExpiresAt: input.supportExpiresAt
      ? new Date(input.supportExpiresAt).toISOString()
      : null,
  });
}
