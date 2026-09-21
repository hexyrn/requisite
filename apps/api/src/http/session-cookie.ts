/**
 * The session cookie carries `${organisationId}.${sessionId}` (both
 * non-secret UUIDs - the session row itself, looked up by id inside
 * withOrgContext(organisationId, ...), is what actually authenticates the
 * request). organisationId must be present to even attempt an org-scoped
 * lookup, since sessions is RLS-protected; a bare sessionId with no org
 * context is unusable by construction, which is the point.
 */
export const SESSION_COOKIE_NAME = 'hexyrn_session';

export function encodeSessionCookie(organisationId: string, sessionId: string): string {
  return `${organisationId}.${sessionId}`;
}

export function decodeSessionCookie(value: string | undefined): { organisationId: string; sessionId: string } | null {
  if (!value) return null;
  const [organisationId, sessionId] = value.split('.');
  if (!organisationId || !sessionId) return null;
  return { organisationId, sessionId };
}
