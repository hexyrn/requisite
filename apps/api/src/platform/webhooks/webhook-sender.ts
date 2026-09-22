/**
 * Outbound HTTP delivery seam for webhooks, P2 item 14. Same DI-swap
 * pattern as StorageProvider (P1) - tests inject a fake sender so no real
 * network call happens, while the default implementation does a genuine
 * HTTP POST in production/dev.
 */
export interface WebhookDeliveryResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

export interface WebhookSender {
  send(url: string, payload: string, headers: Record<string, string>): Promise<WebhookDeliveryResult>;
}

export const WEBHOOK_SENDER = Symbol('WEBHOOK_SENDER');

export class HttpWebhookSender implements WebhookSender {
  async send(url: string, payload: string, headers: Record<string, string>): Promise<WebhookDeliveryResult> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(url, { method: 'POST', body: payload, headers, signal: controller.signal });
      clearTimeout(timeout);
      return { success: response.status >= 200 && response.status < 300, statusCode: response.status };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
