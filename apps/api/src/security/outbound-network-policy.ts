import { lookup as dnsLookup } from 'dns';
import { promisify } from 'util';
import { isIP } from 'net';

const dnsLookupAsync = promisify(dnsLookup);

/**
 * SSRF hardening for outbound HTTP (P3 item 34/12). Applies to every
 * outbound call this codebase makes to an admin-configured URL -
 * currently webhook delivery (webhook-sender.ts) is the only real call
 * site (confirmed by grepping for `fetch(` across src/ - the integration/
 * sync connector framework does not yet make real outbound HTTP calls, see
 * P2-DEVIATIONS.md).
 *
 * DESIGN PRINCIPLE (explicit instruction): Hexyrn is self-hosted. A
 * customer's own webhook receiver may legitimately live on their internal
 * network (10.x/172.16.x/192.168.x, or even localhost if Hexyrn and the
 * receiver run on the same host) - blindly prohibiting all private-network
 * destinations would break a real, legitimate self-hosted use case. This
 * module therefore implements an EXPLICIT, ADMINISTRATOR-CONTROLLED policy
 * rather than a blanket prohibition:
 *
 *   - DEFAULT (safe): loopback, link-local (including the cloud metadata
 *     address 169.254.169.254, which is link-local range), and private
 *     network ranges are all BLOCKED.
 *   - An organisation admin can explicitly allow specific destinations via
 *     `allowedHosts` (exact hostname/IP matches) - a deliberate, narrow
 *     opt-in per trusted internal receiver, not a global "allow everything
 *     private" toggle. This is the "explicit administrator-controlled
 *     outbound-network policy, default safely" the instruction asks for.
 *
 * DNS REBINDING: the policy check resolves the hostname to an actual IP
 * address and validates THAT, not the hostname string - a hostname that
 * currently resolves to an allowed address but could later resolve to an
 * internal one (classic DNS rebinding) is exactly why validation happens
 * per-request (see webhook-sender.ts's use of this module), not once at
 * webhook-registration time, and why `allowedHosts` matching is checked
 * against the resolved IP as well as the original hostname.
 *
 * REDIRECTS: this module validates a single URL; the caller (webhook
 * sender) is responsible for re-validating every redirect hop through this
 * same function rather than letting an HTTP client follow redirects
 * automatically - otherwise a validated initial URL could redirect to an
 * internal address after the check has already passed.
 */
export interface OutboundNetworkPolicy {
  /** Explicit exceptions - exact hostname or IP literal matches, checked against BOTH the original hostname and the resolved IP. Default empty (no exceptions). */
  allowedHosts: string[];
}

export const DEFAULT_OUTBOUND_NETWORK_POLICY: OutboundNetworkPolicy = { allowedHosts: [] };

/**
 * Builds the policy from `HEXYRN_OUTBOUND_ALLOWED_HOSTS` (comma-separated
 * hostnames/IPs) - the administrator-controlled configuration surface this
 * module's design principle calls for. Unset/empty means the safe default
 * (no exceptions - every private/loopback/link-local destination blocked).
 */
export function getConfiguredOutboundNetworkPolicy(): OutboundNetworkPolicy {
  const raw = process.env.HEXYRN_OUTBOUND_ALLOWED_HOSTS ?? '';
  const allowedHosts = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { allowedHosts };
}

export interface UrlValidationResult {
  allowed: boolean;
  reason?: string;
  resolvedIp?: string;
}

function isLoopback(ip: string): boolean {
  if (ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return ip.startsWith('127.');
}

function isLinkLocal(ip: string): boolean {
  // Covers the cloud metadata address 169.254.169.254 (AWS/GCP/Azure IMDS) -
  // it is link-local space, deliberately not special-cased separately so
  // there is one rule, not a maintained list of provider-specific IPs.
  if (ip.startsWith('169.254.')) return true;
  if (ip.toLowerCase().startsWith('fe80:')) return true;
  return false;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true; // "this network" - not routable, treat as unsafe
  return false;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd'); // unique local addresses, fc00::/7
}

function isMulticastOrReserved(ip: string): boolean {
  if (isIP(ip) === 4) {
    const first = parseInt(ip.split('.')[0], 10);
    return first >= 224; // multicast (224-239) + reserved (240-255)
  }
  return ip.toLowerCase().startsWith('ff'); // IPv6 multicast
}

export function classifyIp(ip: string): { blocked: boolean; reason?: string } {
  if (isLoopback(ip)) return { blocked: true, reason: `${ip} is a loopback address.` };
  if (isLinkLocal(ip)) return { blocked: true, reason: `${ip} is a link-local address (this range includes cloud metadata service endpoints such as 169.254.169.254).` };
  if (isIP(ip) === 4 && isPrivateV4(ip)) return { blocked: true, reason: `${ip} is a private IPv4 address.` };
  if (isIP(ip) === 6 && isPrivateV6(ip)) return { blocked: true, reason: `${ip} is a private IPv6 address (unique local address).` };
  if (isMulticastOrReserved(ip)) return { blocked: true, reason: `${ip} is a multicast or reserved address.` };
  return { blocked: false };
}

/**
 * Resolves `url`'s hostname to a real IP and validates it against the
 * policy - this is the check webhook-sender.ts calls before EVERY request,
 * including every redirect hop, per the module doc comment above.
 */
export async function validateOutboundUrl(url: string, policy: OutboundNetworkPolicy = DEFAULT_OUTBOUND_NETWORK_POLICY): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: `"${url}" is not a valid URL.` };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { allowed: false, reason: `Scheme "${parsed.protocol}" is not allowed - only http/https outbound requests are permitted.` };
  }

  const hostname = parsed.hostname;
  if (policy.allowedHosts.includes(hostname)) {
    return { allowed: true, reason: `Hostname "${hostname}" is explicitly allowed by this installation's outbound network policy.` };
  }

  // A literal IP in the URL - no DNS lookup needed/possible.
  if (isIP(hostname)) {
    if (policy.allowedHosts.includes(hostname)) {
      return { allowed: true, resolvedIp: hostname };
    }
    const classified = classifyIp(hostname);
    if (classified.blocked) {
      return { allowed: false, reason: classified.reason, resolvedIp: hostname };
    }
    return { allowed: true, resolvedIp: hostname };
  }

  let resolvedIp: string;
  try {
    const result = await dnsLookupAsync(hostname);
    resolvedIp = result.address;
  } catch (err) {
    return { allowed: false, reason: `Could not resolve hostname "${hostname}": ${err instanceof Error ? err.message : String(err)}` };
  }

  if (policy.allowedHosts.includes(resolvedIp)) {
    return { allowed: true, resolvedIp };
  }

  const classified = classifyIp(resolvedIp);
  if (classified.blocked) {
    return {
      allowed: false,
      reason: `Hostname "${hostname}" resolves to ${resolvedIp}, which is blocked: ${classified.reason} If this is a legitimate internal destination, add it to this installation's outbound network policy allow-list.`,
      resolvedIp,
    };
  }

  return { allowed: true, resolvedIp };
}
