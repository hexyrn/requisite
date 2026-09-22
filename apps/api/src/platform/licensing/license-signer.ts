import { sign as edSign } from 'crypto';
import { randomUUID } from 'crypto';
import { LicensePayload, SignedLicense, canonicalize } from './license-payload';

/**
 * Represents Hexyrn's OFFLINE license-generation tool. This class is
 * committed here because the reference app/tests need SOMETHING to
 * generate valid test licenses with - but it is never invoked by the
 * running Core server itself (grep `LicenseSigner` outside `licensing/`
 * and tests - there is no runtime code path that signs a license; Core
 * only ever verifies). In a real production process, the equivalent of
 * this class runs in Hexyrn's own separate, offline signing environment,
 * using the real private key, which never enters this repository or any
 * Core deployment.
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
