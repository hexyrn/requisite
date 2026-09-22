import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { EventPublisherService } from '../../events/event-publisher.service';
import { EventSchemaService } from '../../events/event-schema.service';
import { WebhookService } from '../webhook.service';
import { WebhookDispatcherService } from '../webhook-dispatcher.service';
import { WebhookSender, WebhookDeliveryResult } from '../webhook-sender';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

class FakeSender implements WebhookSender {
  calls: { url: string; payload: string; headers: Record<string, string> }[] = [];
  nextResults: WebhookDeliveryResult[] = [];

  async send(url: string, payload: string, headers: Record<string, string>): Promise<WebhookDeliveryResult> {
    this.calls.push({ url, payload, headers });
    return this.nextResults.shift() ?? { success: true, statusCode: 200 };
  }
}

describeIfDb('WebhookService / WebhookDispatcherService - signing, delivery, retry (P2 item 14)', () => {
  let pool: Pool;
  let orgA: string;
  const publisher = new EventPublisherService(new EventSchemaService());
  const webhooks = new WebhookService();

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Webhook Org A');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('signs the delivery body with HMAC-SHA256 and a receiver can verify it with the returned signing key', async () => {
    const { signingKey } = await withOrgContext(orgA, (db) => webhooks.registerEndpoint(db, orgA, 'https://example.com/hook', ['reference.widget.created']), pool);
    const body = JSON.stringify({ a: 1 });
    const signature = webhooks.sign(body, signingKey);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(webhooks.verifySignature(body, signingKey, signature)).toBe(true);
    expect(webhooks.verifySignature(body, signingKey, 'sha256=' + '0'.repeat(64))).toBe(false);
  });

  it('rejects a non-https endpoint URL', async () => {
    await expect(withOrgContext(orgA, (db) => webhooks.registerEndpoint(db, orgA, 'http://insecure.example.com/hook', ['*']), pool)).rejects.toThrow(/https/i);
  });

  it('DELIVERY: publishing a subscribed event queues webhook work, which the dispatcher delivers and signs correctly', async () => {
    const sender = new FakeSender();
    const dispatcher = new WebhookDispatcherService(webhooks, sender);
    const { signingKey } = await withOrgContext(orgA, (db) => webhooks.registerEndpoint(db, orgA, 'https://example.com/delivery-test', ['widget.created']), pool);

    await withOrgContext(orgA, (db) => publisher.publish(db, orgA, 'com.hexyrn.reference', 'widget.created', { widgetId: 'w-1' }), pool);

    const result = await dispatcher.dispatchPending(50, pool);
    expect(result.processed).toBe(1);
    expect(sender.calls).toHaveLength(1);

    const call = sender.calls[0];
    expect(call.url).toBe('https://example.com/delivery-test');
    expect(webhooks.verifySignature(call.payload, signingKey, call.headers['x-hexyrn-signature'])).toBe(true);

    const delivery = await withOrgContext(orgA, (db) => db.selectFrom('webhook_deliveries').selectAll().where('event_type', '=', 'widget.created').executeTakeFirstOrThrow(), pool);
    expect(delivery.status).toBe('delivered');
  });

  it('does NOT queue webhook work for an event type with no subscribers', async () => {
    const sender = new FakeSender();
    const dispatcher = new WebhookDispatcherService(webhooks, sender);
    await withOrgContext(orgA, (db) => publisher.publish(db, orgA, 'com.hexyrn.reference', 'nobody.subscribes.to.this', {}), pool);
    await dispatcher.dispatchPending(50, pool);
    expect(sender.calls).toHaveLength(0);
  });

  it('RETRY: a failed delivery is retried on a subsequent dispatch pass and eventually marked failed after max attempts', async () => {
    const sender = new FakeSender();
    // Fail every attempt.
    sender.nextResults = [{ success: false, statusCode: 500 }, { success: false, statusCode: 500 }, { success: false, statusCode: 500 }, { success: false, statusCode: 500 }, { success: false, statusCode: 500 }];
    const dispatcher = new WebhookDispatcherService(webhooks, sender);
    await withOrgContext(orgA, (db) => webhooks.registerEndpoint(db, orgA, 'https://example.com/retry-test', ['widget.retry-event']), pool);
    await withOrgContext(orgA, (db) => publisher.publish(db, orgA, 'com.hexyrn.reference', 'widget.retry-event', {}), pool);

    for (let i = 0; i < 5; i++) {
      await dispatcher.dispatchPending(50, pool);
    }
    expect(sender.calls.length).toBe(5); // MAX_DELIVERY_ATTEMPTS

    const delivery = await withOrgContext(orgA, (db) => db.selectFrom('webhook_deliveries').selectAll().where('event_type', '=', 'widget.retry-event').executeTakeFirstOrThrow(), pool);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempt_count).toBe(5);

    // Terminal - no further dispatch attempts should be made.
    await dispatcher.dispatchPending(50, pool);
    expect(sender.calls.length).toBe(5);
  });
});

describeIfDb('EventSchemaService - payload schema validation (P2 item 15)', () => {
  let pool: Pool;
  let orgA: string;
  const schemas = new EventSchemaService();
  const publisher = new EventPublisherService(schemas);

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Schema Org A');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('accepts a payload matching a registered schema', async () => {
    await withOrgContext(orgA, (db) => schemas.registerSchema(db, 'widget.validated', 1, 'com.hexyrn.reference', { required: ['widgetId'], properties: { widgetId: 'string', count: 'number' } }), pool);
    await expect(withOrgContext(orgA, (db) => publisher.publish(db, orgA, 'com.hexyrn.reference', 'widget.validated', { widgetId: 'w-1', count: 3 }), pool)).resolves.toBeTruthy();
  });

  it('rejects a payload missing a required field', async () => {
    await withOrgContext(orgA, (db) => schemas.registerSchema(db, 'widget.strict', 1, 'com.hexyrn.reference', { required: ['widgetId'], properties: { widgetId: 'string' } }), pool);
    await expect(withOrgContext(orgA, (db) => publisher.publish(db, orgA, 'com.hexyrn.reference', 'widget.strict', {}), pool)).rejects.toThrow(/missing required field/i);
  });

  it('rejects a payload with a wrong field type', async () => {
    await withOrgContext(orgA, (db) => schemas.registerSchema(db, 'widget.typed', 1, 'com.hexyrn.reference', { properties: { count: 'number' } }), pool);
    await expect(withOrgContext(orgA, (db) => publisher.publish(db, orgA, 'com.hexyrn.reference', 'widget.typed', { count: 'not-a-number' }), pool)).rejects.toThrow(/expected type "number"/i);
  });

  it('is a no-op for an event type with no registered schema (additive hardening, not a breaking requirement)', async () => {
    await expect(withOrgContext(orgA, (db) => publisher.publish(db, orgA, 'com.hexyrn.reference', 'widget.unregistered.schema', { anything: 'goes' }), pool)).resolves.toBeTruthy();
  });
});
