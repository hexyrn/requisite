/**
 * Reference app end-to-end test. P1 items 17/18/21 - "launch the reference
 * application through the supported App SDK; demonstrate its Core
 * integrations." Boots the real Nest/Fastify app, bootstraps a real
 * organisation over HTTP, installs+enables+licenses com.hexyrn.reference
 * for it, and drives the FULL widget lifecycle purely through the
 * reference app's own HTTP endpoints - proving, over the same real stack a
 * production deployment would use, that App Registry, the App SDK context,
 * custom fields, numbering, forms, workflow, approvals, and events all
 * genuinely work together, not just in isolation.
 */
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../../app.module';
import { setUpTestDatabase, createTestLicense } from '../../../test-utils/test-db';
import { attachPoolErrorHandler, setPool } from '../../../db/pool';
import { withOrgContext } from '../../../db/org-context';
import { InstallationService } from '../../../bootstrap/installation.service';
import { BootstrapService } from '../../../bootstrap/bootstrap.service';
import { ApplicationRegistryService } from '../../../platform/app-registry/application-registry.service';
import { EventHandlerRegistryService } from '../../../platform/events/event-handler-registry.service';
import { REFERENCE_APP_MANIFEST } from '../reference.manifest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'Reference app (com.hexyrn.reference) - full lifecycle through the App SDK (P1 items 17/18/21)',
  () => {
    let app: NestFastifyApplication;
    let pool: Pool;
    let organisationId: string;
    let ownerEmail: string;
    let ownerPassword: string;
    let agent: ReturnType<typeof request.agent>;
    let csrfToken: string;

    function server() {
      return app.getHttpAdapter().getInstance().server;
    }

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_DATABASE_URL;
      process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
      process.env.COOKIE_SECURE = 'false';

      pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
      await setUpTestDatabase(pool);
      setPool(pool);

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
      await app.register(fastifyCookie as any);
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      // --- Bootstrap the installation + organisation + owner, exactly as a real deployment would. ---
      const installationService = app.get(InstallationService);
      const bootstrapService = app.get(BootstrapService);
      const bootstrap = await installationService.ensureInstallation(pool);
      ownerEmail = 'owner@reference-app.test';
      ownerPassword = 'reference-app-owner-password-1';
      const result = await bootstrapService.completeBootstrap(
        {
          token: bootstrap.plaintextBootstrapToken!,
          organisationName: 'Reference App Org',
          organisationDisplayName: 'Reference App Org',
          defaultCurrency: 'USD',
          timezone: 'UTC',
          locale: 'en-US',
          financialYearStartMonth: 1,
          ownerEmail,
          ownerPassword,
        },
        pool,
      );
      organisationId = result.organisationId;

      // --- Register, enable, and license com.hexyrn.reference for this org - the same App Registry lifecycle any real app goes through. ---
      const registry = app.get(ApplicationRegistryService);
      await registry.registerApp(REFERENCE_APP_MANIFEST, pool);
      await withOrgContext(
        organisationId,
        (db) => registry.enableApp(db, organisationId, REFERENCE_APP_MANIFEST.appId),
        pool,
      );
      const referenceAppLicense = await createTestLicense(
        REFERENCE_APP_MANIFEST.appId,
        organisationId,
        REFERENCE_APP_MANIFEST.majorVersion,
      );
      await withOrgContext(
        organisationId,
        (db) =>
          registry.grantLicense(
            db,
            organisationId,
            REFERENCE_APP_MANIFEST.appId,
            REFERENCE_APP_MANIFEST.majorVersion,
            referenceAppLicense as any,
          ),
        pool,
      );

      // --- Grant the bootstrap owner the reference app's own permissions (Owner's core role does not automatically include app-specific permissions - this is deliberate: installing/enabling an app never silently escalates existing roles). ---
      await withOrgContext(
        organisationId,
        async (db) => {
          const ownerRole = await db
            .selectFrom('roles')
            .selectAll()
            .where('organisation_id', '=', organisationId)
            .where('name', '=', 'Owner')
            .executeTakeFirstOrThrow();
          for (const perm of REFERENCE_APP_MANIFEST.permissions ?? []) {
            await db
              .insertInto('role_permissions')
              .values({
                organisation_id: organisationId,
                role_id: ownerRole.id,
                permission_key: perm.key,
              })
              .onConflict((oc) => oc.doNothing())
              .execute();
          }
        },
        pool,
      );

      agent = request.agent(server());
      const login = await agent
        .post('/api/v1/auth/login')
        .send({ email: ownerEmail, password: ownerPassword });
      expect(login.status).toBe(201);
      csrfToken = login.body.csrfToken;
    }, 60000);

    afterAll(async () => {
      await app.close();
      await pool.end();
    });

    it('APP REGISTRY: the app is genuinely active for this org (installed+enabled+licensed+compatible)', async () => {
      const registry = app.get(ApplicationRegistryService);
      const state = await withOrgContext(
        organisationId,
        (db) => registry.getApplicationState(db, organisationId, REFERENCE_APP_MANIFEST.appId),
        pool,
      );
      expect(state.active).toBe(true);
    });

    it('creates a widget: proves numbering, custom fields, forms, and workflow-start all worked through the App SDK context', async () => {
      const res = await agent
        .post('/api/v1/apps/reference/widgets')
        .set('X-Hexyrn-CSRF', csrfToken)
        .send({ title: 'My First Widget', warrantyStatus: 'active' });
      expect(res.status).toBe(201);
      expect(res.body.widgetNumber).toMatch(/^WID-\d{6}$/); // NUMBERING
      expect(res.body.state).toBe('draft'); // WORKFLOW start
      expect(res.body.customFields.warranty_status).toBe('active'); // CUSTOM FIELDS

      (globalThis as any).__widgetId = res.body.id;
    });

    it('rejects a widget creation that fails form validation (missing required title)', async () => {
      const res = await agent
        .post('/api/v1/apps/reference/widgets')
        .set('X-Hexyrn-CSRF', csrfToken)
        .send({});
      expect(res.status).toBe(400);
    });

    it('submits the widget for approval: proves workflow transition + approval request creation', async () => {
      const widgetId = (globalThis as any).__widgetId;
      const res = await agent
        .post(`/api/v1/apps/reference/widgets/${widgetId}/submit`)
        .set('X-Hexyrn-CSRF', csrfToken);
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');

      (globalThis as any).__requestId = res.body.requestId;
      const check = await agent
        .get(`/api/v1/apps/reference/widgets/${widgetId}`)
        .set('X-Hexyrn-CSRF', csrfToken);
      expect(check.body.state).toBe('submitted');
    });

    it('EVENTS: approving the widget transitions workflow to approved AND publishes reference.widget.approved', async () => {
      const widgetId = (globalThis as any).__widgetId;
      const requestId = (globalThis as any).__requestId;

      const step = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', requestId)
            .executeTakeFirstOrThrow(),
        pool,
      );

      const res = await agent
        .post(`/api/v1/apps/reference/widgets/${widgetId}/decide`)
        .set('X-Hexyrn-CSRF', csrfToken)
        .send({ stepId: step.id, decision: 'approve' });
      expect(res.status).toBe(201);
      expect(res.body.state).toBe('approved');

      const events = await withOrgContext(
        organisationId,
        (db) =>
          db
            .selectFrom('event_outbox')
            .selectAll()
            .where('event_type', '=', 'reference.widget.approved')
            .execute(),
        pool,
      );
      expect(events).toHaveLength(1);
      expect((events[0].payload as any).widgetId).toBe(widgetId);
    });

    it('APP BOUNDARY: without the required permission, the same endpoint is rejected (permission checks are real, not bypassed by the SDK)', async () => {
      await withOrgContext(
        organisationId,
        async (db) => {
          const { hashPassword } = await import('../../../security/passwords');
          await db
            .insertInto('user_accounts')
            .values({
              organisation_id: organisationId,
              email: 'noperm@reference-app.test',
              password_hash: await hashPassword('noperm-password-1'),
              is_active: true,
            })
            .execute();
        },
        pool,
      );
      const otherAgent = request.agent(server());
      const login = await otherAgent
        .post('/api/v1/auth/login')
        .send({ email: 'noperm@reference-app.test', password: 'noperm-password-1' });
      const res = await otherAgent
        .post('/api/v1/apps/reference/widgets')
        .set('X-Hexyrn-CSRF', login.body.csrfToken)
        .send({ title: 'Should be rejected' });
      expect(res.status).toBe(403);
    });

    it('APP INACTIVITY: disabling the app makes its routes 404 (not 403) for everyone, including the owner', async () => {
      const registry = app.get(ApplicationRegistryService);
      await withOrgContext(
        organisationId,
        (db) => registry.disableApp(db, organisationId, REFERENCE_APP_MANIFEST.appId),
        pool,
      );

      const res = await agent
        .get(`/api/v1/apps/reference/widgets/${(globalThis as any).__widgetId}`)
        .set('X-Hexyrn-CSRF', csrfToken);
      expect(res.status).toBe(404);

      // Re-enable for cleanliness / in case more tests run after this in the same file.
      await withOrgContext(
        organisationId,
        (db) => registry.enableApp(db, organisationId, REFERENCE_APP_MANIFEST.appId),
        pool,
      );
    });

    it("CAPABILITY REGISTRY: the reference app's declared capability resolves once the app is active again", async () => {
      const { CapabilityResolverService } =
        await import('../../../platform/capabilities/capability-resolver.service');
      const registry = app.get(ApplicationRegistryService);
      const resolver = new CapabilityResolverService(registry);
      const providers = await withOrgContext(
        organisationId,
        (db) => resolver.resolve(db, organisationId, 'reference.thing.v1'),
        pool,
      );
      expect(providers).toEqual([
        { appId: REFERENCE_APP_MANIFEST.appId, serviceRef: 'ReferenceThingService' },
      ]);
    });

    it('EVENT HANDLER REGISTRY + DISPATCHER: a registered consumer for reference.widget.approved actually receives it', async () => {
      const { EventDispatcherService } =
        await import('../../../platform/events/event-dispatcher.service');
      const registry = app.get(ApplicationRegistryService);
      const handlers = app.get(EventHandlerRegistryService);
      const dispatcher = new EventDispatcherService(registry, handlers);

      let received: any = null;
      handlers.register('consumer.reference-test', async (_db, _org, payload) => {
        received = payload;
      });

      const consumerApp = {
        appId: 'com.hexyrn.reference-consumer-test',
        displayName: 'Test Consumer',
        version: '1.0.0',
        majorVersion: 1,
        requiresCoreVersion: '^0.1.0',
        eventsConsumed: [
          { eventType: 'reference.widget.approved', handlerRef: 'consumer.reference-test' },
        ],
      };
      await registry.registerApp(consumerApp, pool);
      await withOrgContext(
        organisationId,
        (db) => registry.enableApp(db, organisationId, consumerApp.appId),
        pool,
      );
      const consumerAppLicense = await createTestLicense(consumerApp.appId, organisationId, 1);
      await withOrgContext(
        organisationId,
        (db) =>
          registry.grantLicense(
            db,
            organisationId,
            consumerApp.appId,
            1,
            consumerAppLicense as any,
          ),
        pool,
      );

      await dispatcher.dispatchPending(50, pool);
      expect(received).toEqual({ widgetId: (globalThis as any).__widgetId });
    });
  },
);
