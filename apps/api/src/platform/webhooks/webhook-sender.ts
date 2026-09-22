/**
 * Outbound HTTP delivery seam for webhooks, P2 item 14. Same DI-swap
 * pattern as StorageProvider (P1) - tests inject a fake sender so no real
 * network call happens, while the default implementation does a genuine
 * HTTP POST in production/dev.
 *
 * P3 item 34/12 (SSRF hardening): every request AND every redirect hop is
 * validated through security/outbound-network-policy.ts before being
 * followed - see that module's doc comment for the full design rationale
 * (why this is a policy, not a blanket prohibition, and why DNS rebinding
 * matters). `redirect: 'manual'` is used specifically so a validated
 * initial URL cannot be silently redirected to an internal address after
 * the check has already passed - the ordinary `fetch` default of
 * automatically following redirects would defeat this entire module.
 */
import { OutboundNetworkPolicy, DEFAULT_OUTBOUND_NETWORK_POLICY, validateOutboundUrl } from '../../security/outbound-network-policy';

export interface WebhookDeliveryResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

export interface WebhookSender {
  send(url: string, payload: string, headers: Record<string, string>): Promise<WebhookDeliveryResult>;
}

export const WEBHOOK_SENDER = Symbol('WEBHOOK_SENDER');

const MAX_REDIRECTS = 3;

export class HttpWebhookSender implements WebhookSender {
  constructor(private readonly policy: OutboundNetworkPolicy = DEFAULT_OUTBOUND_NETWORK_POLICY) {}

  async send(url: string, payload: string, headers: Record<string, string>): Promise<WebhookDeliveryResult> {
    let currentUrl = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const validation = await validateOutboundUrl(currentUrl, this.policy);
      if (!validation.allowed) {
        return { success: false, error: `Blocked by outbound network policy: ${validation.reason}` };
      }

      let response: Response;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        response = await fetch(currentUrl, {
          method: 'POST',
          body: payload,
          headers,
          signal: controller.signal,
          redirect: 'manual', // never follow automatically - see module doc comment
        });
        clearTimeout(timeout);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }

      // A `redirect: 'manual'` fetch resolves with an "opaqueredirect" type
      // response and status 0 in browser fetch semantics, but Node's
      // implementation surfaces a normal 3xx status with a Location header
      // - handle both by checking status range and the header.
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop === MAX_REDIRECTS) {
          return { success: false, error: `Too many redirects (max ${MAX_REDIRECTS}) - refusing to follow further.` };
        }
        currentUrl = new URL(location, currentUrl).toString();
        continue; // loop back and validate the NEW url before following it
      }

      return { success: response.status >= 200 && response.status < 300, statusCode: response.status };
    }

    return { success: false, error: 'Unreachable - redirect loop guard exhausted.' };
  }
}
