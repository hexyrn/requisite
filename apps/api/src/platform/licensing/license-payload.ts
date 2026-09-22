/**
 * License payload shape + canonical serialization. P2 item 21. The
 * canonical form (stable, sorted key order, no whitespace) is what gets
 * signed and what gets re-verified - any change to any field, including
 * whitespace-insensitive re-ordering by a naive JSON.stringify, would
 * break verification, which is exactly the point (Ed25519 signs bytes,
 * not "semantically equivalent JSON").
 */
export interface LicensePayload {
  licenseId: string;
  appId: string;
  organisationId: string;
  majorVersion: number;
  issuedAt: string; // ISO 8601
  supportExpiresAt: string | null;
}

export interface SignedLicense extends LicensePayload {
  /** base64-encoded Ed25519 signature over canonicalize(payload without this field). */
  signature: string;
}

/** Deterministic JSON serialization: sorted keys, no extra whitespace. */
export function canonicalize(payload: LicensePayload): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    sorted[key] = (payload as unknown as Record<string, unknown>)[key];
  }
  return JSON.stringify(sorted);
}
