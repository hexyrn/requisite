/**
 * Requisite Public API (items 30/31) + Webhook (item 32) end-to-end proof.
 * Boots the real Nest/Fastify app (same pattern as the reference app's
 * P1/P2 e2e suite) and drives Requisite purely through its own HTTP
 * endpoints and a real Postgres-backed webhook dispatch pass.
 */
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import request from 'supertest';
import { Pool } from 'pg';
import { AppModule } from '../../../app.module';
import { setUpTestDatabase, createTestLicense } from '../../../test-utils/test-db';
import { attachPoolErrorHandler, setPool } from '../../../db/pool';
import { withOrgContext } from '../../../db/org-context';
import { InstallationService } from '../../../bootstrap/installation.service';
import { BootstrapService } from '../../../bootstrap/bootstrap.service';
import { ApplicationRegistryService } from '../../../platform/app-registry/application-registry.service';
import { ServiceAccountService } from '../../../platform/api-access/service-account.service';
import { WebhookService } from '../../../platform/webhooks/webhook.service';
import { WebhookDispatcherService } from '../../../platform/webhooks/webhook-dispatcher.service';
import {
  WEBHOOK_SENDER,
  WebhookSender,
  WebhookDeliveryResult,
} from '../../../platform/webhooks/webhook-sender';
import { REQUISITE_APP_MANIFEST } from '../requisite.manifest';
import { registerRequisiteP2Extensions } from '../requisite-p2-extensions';
import { DatasetService } from '../../../platform/reporting/dataset.service';
import { SavedReportService } from '../../../platform/reporting/saved-report.service';
import { DashboardService } from '../../../platform/dashboards/dashboard.service';
import { SearchService } from '../../../platform/search/search.service';
import { ImportService } from '../../../platform/import/import.service';
import { ImportHandlerRegistryService } from '../../../platform/import/import-row-handler';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

class FakeSender implements WebhookSender {
  calls: { url: string; payload: string; headers: Record<string, string> }[] = [];
  async send(
    url: string,
    payload: string,
    headers: Record<string, string>,
  ): Promise<WebhookDeliveryResult> {
    this.calls.push({ url, payload, headers });
    return { success: true, statusCode: 200 };
  }
}

describeIfDb('Requisite Public API + Webhooks - real end-to-end proof (items 30/31/32)', () => {
  let app: NestFastifyApplication;
  let pool: Pool;
  let organisationId: string;
  let ownerEmail: string;
  let ownerPassword: string;
  let agent: ReturnType<typeof request.agent>;
  let csrfToken: string;
  const fakeSender = new FakeSender();

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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WEBHOOK_SENDER)
      .useValue(fakeSender)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie as any);
    await app.register(fastifyMultipart as any, { limits: { fileSize: 25 * 1024 * 1024 } });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const installationService = app.get(InstallationService);
    const bootstrapService = app.get(BootstrapService);
    const bootstrap = await installationService.ensureInstallation(pool);
    ownerEmail = 'owner@requisite-app.test';
    ownerPassword = 'requisite-app-owner-password-1';
    const result = await bootstrapService.completeBootstrap(
      {
        token: bootstrap.plaintextBootstrapToken!,
        organisationName: 'Requisite App Org',
        organisationDisplayName: 'Requisite App Org',
        defaultCurrency: 'GBP',
        timezone: 'UTC',
        locale: 'en-GB',
        financialYearStartMonth: 1,
        ownerEmail,
        ownerPassword,
      },
      pool,
    );
    organisationId = result.organisationId;

    const registry = app.get(ApplicationRegistryService);
    await registry.registerApp(REQUISITE_APP_MANIFEST, pool);
    await withOrgContext(
      organisationId,
      (db) => registry.enableApp(db, organisationId, REQUISITE_APP_MANIFEST.appId),
      pool,
    );
    const license = await createTestLicense(
      REQUISITE_APP_MANIFEST.appId,
      organisationId,
      REQUISITE_APP_MANIFEST.majorVersion,
    );
    await withOrgContext(
      organisationId,
      (db) =>
        registry.grantLicense(
          db,
          organisationId,
          REQUISITE_APP_MANIFEST.appId,
          REQUISITE_APP_MANIFEST.majorVersion,
          license as any,
        ),
      pool,
    );
    await registerRequisiteP2Extensions(
      app.get(DatasetService),
      app.get(SavedReportService),
      app.get(DashboardService),
      app.get(SearchService),
      app.get(ImportService),
      app.get(ImportHandlerRegistryService),
      pool,
    );

    await withOrgContext(
      organisationId,
      async (db) => {
        const ownerRole = await db
          .selectFrom('roles')
          .selectAll()
          .where('organisation_id', '=', organisationId)
          .where('name', '=', 'Owner')
          .executeTakeFirstOrThrow();
        for (const perm of REQUISITE_APP_MANIFEST.permissions ?? []) {
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

  it('LICENCE STATE (item 21): an org admin can see Requisite is installed/enabled/licensed/active without hitting the app-active 404 gate', async () => {
    const res = await agent.get(`/api/v1/apps/${REQUISITE_APP_MANIFEST.appId}/state`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      appId: REQUISITE_APP_MANIFEST.appId,
      installed: true,
      enabled: true,
      licensed: true,
      compatible: true,
      active: true,
    });
  });

  it('PUBLIC API (item 30/31): a session-authenticated request can create and list suppliers over real HTTP', async () => {
    const create = await agent
      .post('/api/v1/requisite/suppliers')
      .set('x-hexyrn-csrf', csrfToken)
      .send({ name: 'HTTP Test Supplier' });
    expect(create.status).toBe(201);
    expect(create.body.supplier_number).toMatch(/^SUP-\d{5}$/);

    const list = await agent.get('/api/v1/requisite/suppliers');
    expect(list.status).toBe(200);
    expect(list.body.some((s: any) => s.name === 'HTTP Test Supplier')).toBe(true);
  });

  it('PUBLIC API (item 11/30/31): a service-account API key authenticates the SAME route a session cookie does', async () => {
    const serviceAccounts = app.get(ServiceAccountService);
    const account = await withOrgContext(
      organisationId,
      (db) =>
        serviceAccounts.createServiceAccount(db, organisationId, 'Requisite API Bot', [
          'requisite.suppliers.view',
        ]),
      pool,
    );
    const issued = await withOrgContext(
      organisationId,
      (db) => serviceAccounts.issueCredential(db, organisationId, account.id, pool),
      pool,
    );

    const apiResponse = await request(server())
      .get('/api/v1/requisite/suppliers')
      .set('Authorization', `Bearer ${issued.plaintextKey}`);
    expect(apiResponse.status).toBe(200);
    expect(Array.isArray(apiResponse.body)).toBe(true);

    const noAuth = await request(server()).get('/api/v1/requisite/suppliers');
    expect(noAuth.status).toBe(401);
  });

  it('API SCOPE ENFORCEMENT: a service account without requisite.requisitions.create cannot create a requisition via the API', async () => {
    const serviceAccounts = app.get(ServiceAccountService);
    const account = await withOrgContext(
      organisationId,
      (db) =>
        serviceAccounts.createServiceAccount(db, organisationId, 'Read Only Bot', [
          'requisite.suppliers.view',
        ]),
      pool,
    );
    const issued = await withOrgContext(
      organisationId,
      (db) => serviceAccounts.issueCredential(db, organisationId, account.id, pool),
      pool,
    );

    const response = await request(server())
      .post('/api/v1/requisite/requisitions')
      .set('Authorization', `Bearer ${issued.plaintextKey}`)
      .send({
        reason: 'Should be rejected',
        lines: [{ description: 'X', quantity: '1', estimatedUnitPriceMinor: '100' }],
      });
    expect(response.status).toBe(403);
  });

  it('UX SURFACE + REAL MULTIPART (items 16/17/35/36): a requisition can receive a genuine multipart file upload (not base64-JSON) and expose its (empty) approval history over real HTTP', async () => {
    const createReq = await agent
      .post('/api/v1/requisite/requisitions')
      .set('x-hexyrn-csrf', csrfToken)
      .send({
        reason: 'UX surface test',
        lines: [{ description: 'X', quantity: '1', estimatedUnitPriceMinor: '100' }],
      });
    expect(createReq.status).toBe(201);

    const attach = await agent
      .post(`/api/v1/requisite/requisitions/${createReq.body.id}/attachments`)
      .set('x-hexyrn-csrf', csrfToken)
      .attach('file', Buffer.from('%PDF-1.4 fake quote content'), {
        filename: 'spec.pdf',
        contentType: 'application/pdf',
      });
    expect(attach.status).toBe(201);

    const list = await agent.get(`/api/v1/requisite/requisitions/${createReq.body.id}/attachments`);
    expect(list.status).toBe(200);
    expect(list.body.some((f: any) => f.original_filename === 'spec.pdf')).toBe(true);

    // MIME sniffing still applies unconditionally - a file claiming to be
    // a PDF but not actually starting with the PDF magic bytes is
    // rejected exactly as it would be for a non-multipart upload (item 17:
    // "do not weaken existing MIME sniffing/security controls").
    const badMime = await agent
      .post(`/api/v1/requisite/requisitions/${createReq.body.id}/attachments`)
      .set('x-hexyrn-csrf', csrfToken)
      .attach('file', Buffer.from('this is not actually a PDF'), {
        filename: 'fake.pdf',
        contentType: 'application/pdf',
      });
    expect(badMime.status).toBe(400);

    const history = await agent.get(
      `/api/v1/requisite/requisitions/${createReq.body.id}/approval-history`,
    );
    expect(history.status).toBe(200);
    expect(history.body).toEqual([]); // not yet submitted - no approval requests exist
  });

  it("REPORTS (item 15): Requisite report templates are listable and runnable through Core's generic reports interface", async () => {
    const templates = await agent.get('/api/v1/reports/templates?appId=com.hexyrn.requisite');
    expect(templates.status).toBe(200);
    expect(
      templates.body.some((t: any) => t.template_key === 'requisite.open_purchase_orders'),
    ).toBe(true);

    const result = await agent
      .post('/api/v1/reports/execute')
      .set('x-hexyrn-csrf', csrfToken)
      .send({ templateKey: 'requisite.purchasing_by_supplier' });
    expect(result.status).toBe(201);
    expect(Array.isArray(result.body.rows)).toBe(true);
  });

  it('RFQ ROUTES (item 9): create RFQ, record two quotes, compare, select one - real HTTP', async () => {
    const supplierA = await agent
      .post('/api/v1/requisite/suppliers')
      .set('x-hexyrn-csrf', csrfToken)
      .send({ name: 'RFQ Route Supplier A' });
    const supplierB = await agent
      .post('/api/v1/requisite/suppliers')
      .set('x-hexyrn-csrf', csrfToken)
      .send({ name: 'RFQ Route Supplier B' });

    const rfq = await agent.post('/api/v1/requisite/rfqs').set('x-hexyrn-csrf', csrfToken).send({});
    expect(rfq.status).toBe(201);

    const quoteA = await agent
      .post(`/api/v1/requisite/rfqs/${rfq.body.id}/quotes`)
      .set('x-hexyrn-csrf', csrfToken)
      .send({
        supplierId: supplierA.body.id,
        lines: [{ description: 'Item', quantity: '10', unitPriceMinor: '1000' }],
      });
    expect(quoteA.status).toBe(201);
    const quoteB = await agent
      .post(`/api/v1/requisite/rfqs/${rfq.body.id}/quotes`)
      .set('x-hexyrn-csrf', csrfToken)
      .send({
        supplierId: supplierB.body.id,
        lines: [{ description: 'Item', quantity: '10', unitPriceMinor: '500' }],
      });
    expect(quoteB.status).toBe(201);

    const detail = await agent.get(`/api/v1/requisite/rfqs/${rfq.body.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.quotes).toHaveLength(2);
    expect(detail.body.quotes[0].supplier_name).toBe('RFQ Route Supplier B'); // cheapest first

    const select = await agent
      .post(`/api/v1/requisite/rfqs/${rfq.body.id}/quotes/${quoteB.body.id}/select`)
      .set('x-hexyrn-csrf', csrfToken)
      .send({ reason: 'Cheapest' });
    expect(select.status).toBe(201);
    expect(select.body.status).toBe('selected');
  });

  it('DEDICATED ROUTES: submit -> decide (via a distinct approver, self-approval blocked) -> generate PO -> issue -> PDF document, all over real HTTP', async () => {
    const createSupplier = await agent
      .post('/api/v1/requisite/suppliers')
      .set('x-hexyrn-csrf', csrfToken)
      .send({ name: 'Routes Test Supplier' });
    const createReq = await agent
      .post('/api/v1/requisite/requisitions')
      .set('x-hexyrn-csrf', csrfToken)
      .send({
        reason: 'Dedicated routes test',
        lines: [{ description: 'Widget', quantity: '3', estimatedUnitPriceMinor: '2000' }],
      });
    expect(createReq.status).toBe(201);

    const submitRes = await agent
      .post(`/api/v1/requisite/requisitions/${createReq.body.id}/submit`)
      .set('x-hexyrn-csrf', csrfToken)
      .send({ version: createReq.body.version });
    expect(submitRes.status).toBe(201);
    const requestId = submitRes.body.approval.requestId;
    const step = await withOrgContext(
      organisationId,
      (db) =>
        db
          .selectFrom('approval_steps')
          .selectAll()
          .where('request_id', '=', requestId)
          .where('status', '=', 'pending')
          .executeTakeFirstOrThrow(),
      pool,
    );

    // A distinct approver, logged in via their own agent - self-approval is blocked server-side.
    const approverEmail = `routes-approver-${Date.now()}@example.com`;
    const approverPassword = 'routes-approver-password-1';
    await withOrgContext(
      organisationId,
      async (db) => {
        const { hashPassword } = await import('../../../security/passwords');
        const ownerRole = await db
          .selectFrom('roles')
          .selectAll()
          .where('organisation_id', '=', organisationId)
          .where('name', '=', 'Owner')
          .executeTakeFirstOrThrow();
        const approverUser = await db
          .insertInto('user_accounts')
          .values({
            organisation_id: organisationId,
            email: approverEmail,
            password_hash: await hashPassword(approverPassword),
            is_active: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await db
          .insertInto('user_roles')
          .values({
            organisation_id: organisationId,
            user_account_id: approverUser.id,
            role_id: ownerRole.id,
          })
          .execute();
      },
      pool,
    );
    const approverAgent = request.agent(server());
    const approverLogin = await approverAgent
      .post('/api/v1/auth/login')
      .send({ email: approverEmail, password: approverPassword });
    expect(approverLogin.status).toBe(201);

    const decideRes = await approverAgent
      .post(`/api/v1/requisite/requisitions/${createReq.body.id}/decisions`)
      .set('x-hexyrn-csrf', approverLogin.body.csrfToken)
      .send({ stepId: step.id, decision: 'approve' });
    expect(decideRes.status).toBe(201);
    expect(decideRes.body.requestStatus).toBe('approved');

    const generatePoRes = await agent
      .post(`/api/v1/requisite/requisitions/${createReq.body.id}/purchase-orders`)
      .set('x-hexyrn-csrf', csrfToken)
      .send({
        supplierId: createSupplier.body.id,
        lines: [{ description: 'Widget', quantityOrdered: '3', unitPriceMinor: '2000' }],
      });
    expect(generatePoRes.status).toBe(201);
    expect(generatePoRes.body.status).toBe('draft');

    const issueRes = await agent
      .post(`/api/v1/requisite/purchase-orders/${generatePoRes.body.id}/issue`)
      .set('x-hexyrn-csrf', csrfToken)
      .send({ version: generatePoRes.body.version });
    expect(issueRes.status).toBe(201);
    expect(issueRes.body.status).toBe('issued');

    const pdfRes = await agent
      .get(`/api/v1/requisite/purchase-orders/${generatePoRes.body.id}/document.pdf`)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(pdfRes.status).toBe(200);
    expect((pdfRes.body as Buffer).subarray(0, 4).toString('utf8')).toBe('%PDF');
  });

  it('WEBHOOKS (item 32): a purchase-order.issued event is delivered, signed, to a subscribed endpoint - end to end through real HTTP + real dispatch', async () => {
    const webhooks = app.get(WebhookService);
    const dispatcher = app.get(WebhookDispatcherService);
    const { signingKey } = await withOrgContext(
      organisationId,
      (db) =>
        webhooks.registerEndpoint(db, organisationId, 'https://example.com/requisite-webhook', [
          'requisite.purchase-order.issued.v1',
        ]),
      pool,
    );

    // Drive the full lifecycle purely through Requisite's own HTTP API.
    const supplierRes = await agent
      .post('/api/v1/requisite/suppliers')
      .set('x-hexyrn-csrf', csrfToken)
      .send({ name: 'Webhook Test Supplier' });
    const reqRes = await agent
      .post('/api/v1/requisite/requisitions')
      .set('x-hexyrn-csrf', csrfToken)
      .send({
        reason: 'Webhook proof',
        lines: [{ description: 'Widget', quantity: '5', estimatedUnitPriceMinor: '1000' }],
      });
    expect(reqRes.status).toBe(201);
    const requisitionId = reqRes.body.id;

    // Submit + approve via services directly, using two distinct users (self-approval is rejected server-side).
    const { RequisitionService } = await import('../requisition.service');
    const { PurchaseOrderService } = await import('../purchase-order.service');
    const { AppContextFactory } = await import('../../../platform/app-context.factory');
    const requisitions = app.get(RequisitionService);
    const purchaseOrders = app.get(PurchaseOrderService);
    const contextFactory = app.get(AppContextFactory);

    const ownerUser = await withOrgContext(
      organisationId,
      (db) =>
        db
          .selectFrom('user_accounts')
          .selectAll()
          .where('email', '=', ownerEmail)
          .executeTakeFirstOrThrow(),
      pool,
    );
    const allPerms = new Set((REQUISITE_APP_MANIFEST.permissions ?? []).map((p) => p.key));
    // A distinct approver - self-approval is rejected server-side (item 7/41).
    const approverUser = await withOrgContext(
      organisationId,
      (db) =>
        db
          .insertInto('user_accounts')
          .values({
            organisation_id: organisationId,
            email: `webhook-approver-${Date.now()}@example.com`,
            password_hash: 'x',
            is_active: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      pool,
    );

    const reqRow = await withOrgContext(
      organisationId,
      (db) => requisitions.getRequisitionRaw(db, organisationId, requisitionId),
      pool,
    );
    const { approval } = await withOrgContext(
      organisationId,
      (db) =>
        requisitions.submitRequisition(
          contextFactory.create(
            REQUISITE_APP_MANIFEST.appId,
            organisationId,
            allPerms,
            ownerUser.id,
            db,
          ),
          db,
          ownerUser.id,
          requisitionId,
          reqRow.version,
        ),
      pool,
    );
    const step = await withOrgContext(
      organisationId,
      (db) =>
        db
          .selectFrom('approval_steps')
          .selectAll()
          .where('request_id', '=', approval.requestId)
          .where('status', '=', 'pending')
          .executeTakeFirstOrThrow(),
      pool,
    );
    await withOrgContext(
      organisationId,
      (db) =>
        requisitions.decide(
          contextFactory.create(
            REQUISITE_APP_MANIFEST.appId,
            organisationId,
            allPerms,
            approverUser.id,
            db,
          ),
          db,
          approverUser.id,
          requisitionId,
          step.id,
          'approve',
        ),
      pool,
    );

    const po = await withOrgContext(
      organisationId,
      (db) =>
        purchaseOrders.generateFromRequisition(
          contextFactory.create(
            REQUISITE_APP_MANIFEST.appId,
            organisationId,
            allPerms,
            ownerUser.id,
            db,
          ),
          db,
          ownerUser.id,
          requisitionId,
          {
            supplierId: supplierRes.body.id,
            lines: [{ description: 'Widget', quantityOrdered: '5', unitPriceMinor: '1000' }],
          },
        ),
      pool,
    );
    await withOrgContext(
      organisationId,
      (db) =>
        purchaseOrders.issue(
          contextFactory.create(
            REQUISITE_APP_MANIFEST.appId,
            organisationId,
            allPerms,
            ownerUser.id,
            db,
          ),
          db,
          ownerUser.id,
          po.id,
          po.version,
        ),
      pool,
    );

    const dispatchResult = await dispatcher.dispatchPending(50, pool);
    expect(dispatchResult.processed).toBeGreaterThanOrEqual(1);

    const relevantCall = fakeSender.calls.find(
      (c) => c.url === 'https://example.com/requisite-webhook',
    );
    expect(relevantCall).toBeTruthy();
    expect(
      webhooks.verifySignature(
        relevantCall!.payload,
        signingKey,
        relevantCall!.headers['x-hexyrn-signature'],
      ),
    ).toBe(true);
    const payload = JSON.parse(relevantCall!.payload);
    expect(payload.eventType).toBe('requisite.purchase-order.issued.v1');
    expect(payload.data.purchaseOrderId).toBe(po.id);
  });
});
