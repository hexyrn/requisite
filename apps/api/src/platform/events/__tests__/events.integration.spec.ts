import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { ApplicationRegistryService } from '../../app-registry/application-registry.service';
import { EventPublisherService } from '../event-publisher.service';
import { EventHandlerRegistryService } from '../event-handler-registry.service';
import { EventDispatcherService } from '../event-dispatcher.service';
import { HexyrnAppManifest } from '@hexyrn/app-sdk';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const producerApp: HexyrnAppManifest = { appId: 'com.hexyrn.producer', displayName: 'Producer', version: '1.0.0', majorVersion: 1, requiresCoreVersion: '^0.1.0' };
const consumerApp: HexyrnAppManifest = {
  appId: 'com.hexyrn.consumer',
  displayName: 'Consumer',
  version: '1.0.0',
  majorVersion: 1,
  requiresCoreVersion: '^0.1.0',
  eventsConsumed: [{ eventType: 'goods.received', handlerRef: 'consumer.on-goods-received' }],
};

describeIfDb('Event outbox: publication, retry, consumer failure, org context (P1 item 4)', () => {
  let pool: Pool;
  let orgId: string;
  const registry = new ApplicationRegistryService();
  const publisher = new EventPublisherService();
  const handlers = new EventHandlerRegistryService();
  const dispatcher = new EventDispatcherService(registry, handlers);

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgId = await createTestOrg(pool, 'Events Test Org');
    await registry.registerApp(producerApp, pool);
    await registry.registerApp(consumerApp, pool);
    await withOrgContext(orgId, (db) => registry.enableApp(db, orgId, consumerApp.appId), pool);
    await withOrgContext(orgId, (db) => registry.grantLicense(db, orgId, consumerApp.appId, 1, { signature: 'x' }), pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('PUBLICATION: publish() writes a row inside the caller transaction; a consumer receives it after dispatch', async () => {
    const received: Record<string, unknown>[] = [];
    handlers.register('consumer.on-goods-received', async (_db, _org, payload) => {
      received.push(payload);
    });

    await withOrgContext(orgId, (db) => publisher.publish(db, orgId, producerApp.appId, 'goods.received', { poNumber: 'PO-1', quantity: 5 }), pool);
    const { processed } = await dispatcher.dispatchPending(50, pool);
    expect(processed).toBe(1);
    expect(received).toEqual([{ poNumber: 'PO-1', quantity: 5 }]);
  });

  it('ABSENT CONSUMER: publishing an event type nobody consumes never errors, and the publisher keeps working', async () => {
    await expect(withOrgContext(orgId, (db) => publisher.publish(db, orgId, producerApp.appId, 'nobody.listens', {}), pool)).resolves.toBeDefined();
    const { processed } = await dispatcher.dispatchPending(50, pool);
    expect(processed).toBe(1); // dispatched (zero consumers to deliver to, so trivially "done")
  });

  it('CONSUMER FAILURE + RETRY: a throwing handler is retried, and a fixed handler succeeds on a later pass without re-processing the earlier failure as a duplicate', async () => {
    let attempts = 0;
    handlers.register('consumer.flaky', async () => {
      attempts++;
      if (attempts < 3) throw new Error('simulated transient failure');
    });
    const flakyConsumer: HexyrnAppManifest = {
      appId: 'com.hexyrn.flaky-consumer',
      displayName: 'Flaky',
      version: '1.0.0',
      majorVersion: 1,
      requiresCoreVersion: '^0.1.0',
      eventsConsumed: [{ eventType: 'flaky.event', handlerRef: 'consumer.flaky' }],
    };
    await registry.registerApp(flakyConsumer, pool);
    await withOrgContext(orgId, (db) => registry.enableApp(db, orgId, flakyConsumer.appId), pool);
    await withOrgContext(orgId, (db) => registry.grantLicense(db, orgId, flakyConsumer.appId, 1, { signature: 'x' }), pool);

    await withOrgContext(orgId, (db) => publisher.publish(db, orgId, producerApp.appId, 'flaky.event', {}), pool);

    await dispatcher.dispatchPending(50, pool); // attempt 1: fails
    expect(attempts).toBe(1);
    await dispatcher.dispatchPending(50, pool); // attempt 2: fails
    expect(attempts).toBe(2);
    await dispatcher.dispatchPending(50, pool); // attempt 3: succeeds
    expect(attempts).toBe(3);
    await dispatcher.dispatchPending(50, pool); // nothing left to do - IDEMPOTENCY: must not invoke the handler a 4th time
    expect(attempts).toBe(3);
  });

  it('ORG CONTEXT: an event published for one org is never delivered as if it were another org\'s event', async () => {
    const orgB = await createTestOrg(pool, 'Events Org B');
    await registry.registerApp(consumerApp, pool);
    await withOrgContext(orgB, (db) => registry.enableApp(db, orgB, consumerApp.appId), pool);
    await withOrgContext(orgB, (db) => registry.grantLicense(db, orgB, consumerApp.appId, 1, { signature: 'x' }), pool);

    const seenOrgIds: string[] = [];
    handlers.register('consumer.org-tracker', async (_db, organisationId) => {
      seenOrgIds.push(organisationId);
    });
    const trackerApp: HexyrnAppManifest = {
      appId: 'com.hexyrn.org-tracker',
      displayName: 'Org Tracker',
      version: '1.0.0',
      majorVersion: 1,
      requiresCoreVersion: '^0.1.0',
      eventsConsumed: [{ eventType: 'org.tracked', handlerRef: 'consumer.org-tracker' }],
    };
    await registry.registerApp(trackerApp, pool);
    for (const org of [orgId, orgB]) {
      await withOrgContext(org, (db) => registry.enableApp(db, org, trackerApp.appId), pool);
      await withOrgContext(org, (db) => registry.grantLicense(db, org, trackerApp.appId, 1, { signature: 'x' }), pool);
    }

    await withOrgContext(orgId, (db) => publisher.publish(db, orgId, producerApp.appId, 'org.tracked', {}), pool);
    await withOrgContext(orgB, (db) => publisher.publish(db, orgB, producerApp.appId, 'org.tracked', {}), pool);
    await dispatcher.dispatchPending(50, pool);

    expect(seenOrgIds.sort()).toEqual([orgId, orgB].sort());
  });

  it('a consumer app that is installed but NOT active (unlicensed) is skipped, not delivered to', async () => {
    let invoked = false;
    handlers.register('consumer.unlicensed', async () => {
      invoked = true;
    });
    const unlicensedApp: HexyrnAppManifest = {
      appId: 'com.hexyrn.unlicensed-consumer',
      displayName: 'Unlicensed',
      version: '1.0.0',
      majorVersion: 1,
      requiresCoreVersion: '^0.1.0',
      eventsConsumed: [{ eventType: 'unlicensed.event', handlerRef: 'consumer.unlicensed' }],
    };
    await registry.registerApp(unlicensedApp, pool);
    await withOrgContext(orgId, (db) => registry.enableApp(db, orgId, unlicensedApp.appId), pool);
    // Deliberately never license it.

    await withOrgContext(orgId, (db) => publisher.publish(db, orgId, producerApp.appId, 'unlicensed.event', {}), pool);
    await dispatcher.dispatchPending(50, pool);
    expect(invoked).toBe(false);

    const delivery = await withOrgContext(
      orgId,
      (db) => db.selectFrom('event_deliveries').selectAll().where('consumer_app_id', '=', unlicensedApp.appId).executeTakeFirst(),
      pool,
    );
    expect(delivery?.status).toBe('skipped');
  });
});
