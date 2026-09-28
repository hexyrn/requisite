import { verify as edVerify } from 'crypto';
import { Injectable } from '@nestjs/common';
import { SignedLicense, canonicalize } from './license-payload';
import { getConfiguredPublicKey } from './keys';

export interface LicenseVerificationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Pure, offline, local cryptographic verification. P2 item 21. No network
 * call exists anywhere in this class - verification is a signature check
 * against the locally-configured public key and nothing else, which is
 * what makes "no mandatory online activation" and "works with no network
 * connectivity" true by construction, not by omission.
 */
@Injectable()
export class LicenseVerifier {
  verify(
    license: SignedLicense,
    expected: { appId: string; organisationId: string; majorVersion: number },
  ): LicenseVerificationResult {
    const { signature, ...payload } = license;

    let signatureValid: boolean;
    try {
      signatureValid = edVerify(
        null,
        Buffer.from(canonicalize(payload)),
        getConfiguredPublicKey(),
        Buffer.from(signature, 'base64'),
      );
    } catch {
      return { valid: false, reason: 'The licence file is damaged. Ask Hexyrn for a new copy.' };
    }
    if (!signatureValid) {
      return {
        valid: false,
        reason:
          'This licence file was not issued by Hexyrn, or has been changed since it was issued. Ask Hexyrn for a new copy.',
      };
    }

    if (payload.appId !== expected.appId) {
      return {
        valid: false,
        reason: 'This licence is for a different Hexyrn product.',
      };
    }
    if (payload.organisationId !== expected.organisationId) {
      return {
        valid: false,
        reason:
          'This licence was issued for a different organisation. Check the Organisation ID you gave Hexyrn matches the one shown on this page.',
      };
    }
    if (payload.majorVersion !== expected.majorVersion) {
      return {
        valid: false,
        reason: 'This licence is for a different version of Requisite than the one installed.',
      };
    }

    return { valid: true };
  }
}
