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
      return { valid: false, reason: 'Malformed signature.' };
    }
    if (!signatureValid) {
      return {
        valid: false,
        reason:
          'Invalid signature - the license payload does not match its signature, or was not signed with a trusted key.',
      };
    }

    if (payload.appId !== expected.appId) {
      return {
        valid: false,
        reason: `License is for app "${payload.appId}", not "${expected.appId}".`,
      };
    }
    if (payload.organisationId !== expected.organisationId) {
      return { valid: false, reason: 'License was not issued for this organisation.' };
    }
    if (payload.majorVersion !== expected.majorVersion) {
      return {
        valid: false,
        reason: `License covers major version ${payload.majorVersion}, not ${expected.majorVersion}.`,
      };
    }

    return { valid: true };
  }
}
