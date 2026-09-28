import { sign as edSign } from 'crypto';
import { randomUUID } from 'crypto';
import {
  LicensePayload,
  SignedLicense,
  canonicalize,
} from '../../platform/licensing/license-payload';

/**
 * Hexyrn's OFFLINE licence-signing logic.
 *
 * This file lives in src/vendor-tools/, which is EXCLUDED from the compiled application
 * (tsconfig.json "exclude") and therefore never appears in a customer installation - not in the
 * Windows installer, not in any other build of the server. The running server can only VERIFY
 * licences (platform/licensing/license-verifier.ts); nothing that ships can sign one.
 *
 * It is used by (a) Hexyrn's own licence-issuing tool (scripts/licence-tool.ts) with the real
 * private key held offline by Hexyrn, and (b) the automated tests, with the clearly-labelled
 * throw-away test key in ./test-keys.ts.
 */
export class LicenseSigner {
  constructor(private readonly privateKeyPem: string) {}

  issue(
    input: Omit<LicensePayload, 'licenseId' | 'issuedAt'> & {
      licenseId?: string;
      issuedAt?: string;
    },
  ): SignedLicense {
    const payload: LicensePayload = {
      licenseId: input.licenseId ?? randomUUID(),
      appId: input.appId,
      organisationId: input.organisationId,
      majorVersion: input.majorVersion,
      issuedAt: input.issuedAt ?? new Date().toISOString(),
      supportExpiresAt: input.supportExpiresAt,
    };
    const signature = edSign(null, Buffer.from(canonicalize(payload)), this.privateKeyPem).toString(
      'base64',
    );
    return { ...payload, signature };
  }
}
