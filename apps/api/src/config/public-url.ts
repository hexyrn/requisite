/**
 * The address people type to reach this installation, used to build links (invitations). Prefers the
 * operator-configured HEXYRN_PUBLIC_URL, then the first ALLOWED_ORIGINS entry, and only then the request's
 * own Host header (which a client controls, so it is the last resort).
 */
export function resolvePublicBaseUrl(
  requestProtocol: string,
  requestHost: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured =
    env.HEXYRN_PUBLIC_URL?.trim() ||
    (env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .find(Boolean);
  if (configured) return configured.replace(/\/+$/, '');
  return `${requestProtocol}://${requestHost ?? 'localhost'}`;
}
