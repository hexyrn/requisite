import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { AppContextFactory } from '../../../platform/app-context.factory';
import { CapabilityResolverService } from '../../../platform/capabilities/capability-resolver.service';
import { ApplicationRegistryService } from '../../../platform/app-registry/application-registry.service';
import { EventPublisherService } from '../../../platform/events/event-publisher.service';
import { CustomFieldService } from '../../../platform/custom-fields/custom-field.service';
import { NumberingService } from '../../../platform/numbering/numbering.service';
import { WorkflowService } from '../../../platform/workflow/workflow.service';
import { ApprovalService } from '../../../platform/approval/approval.service';
import { NotificationService } from '../../../platform/notifications/notification.service';
import { FileService } from '../../../platform/files/file.service';
import { ScheduledJobService } from '../../../platform/scheduling/scheduled-job.service';
import { TerminologyService } from '../../../platform/terminology/terminology.service';
import { FormService } from '../../../platform/forms/form.service';
import { RequisiteOnboardingService } from '../requisite-onboarding.service';
import { SupplierService } from '../supplier.service';
import { RequisitionService } from '../requisition.service';
import { PurchaseOrderService } from '../purchase-order.service';
import { REQUISITE_APP_MANIFEST } from '../requisite.manifest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Requisite PurchaseOrderService - generation, issue, duplicate prevention (items 8/39/42)', () => {
  let pool: Pool;
  let orgA: string;
  const contextFactory = new AppContextFactory(
    new CapabilityResolverService(new ApplicationRegistryService()),
    new EventPublisherService(),
    new CustomFieldService(),
    new NumberingService(),
    new WorkflowService(),
    new ApprovalService(),
    new NotificationService(),
    new FileService(),
    new ScheduledJobService(),
    new TerminologyService(),
  );
  const onboarding = new RequisiteOnboardingService(new NumberingService(), new FormService(), new WorkflowService(), new ApprovalService(), new CustomFieldService());
  const suppliers = new SupplierService(onboarding);
  const requisitions = new RequisitionService(onboarding);
  const purchaseOrders = new PurchaseOrderService(onboarding);

  function ctx(organisationId: string, actorId: string, permissions: string[] = []) {
    return (db: any) => contextFactory.create(REQUISITE_APP_MANIFEST.appId, organisationId, new Set(permissions), actorId, db);
  }

  async function makeUser(organisationId: string): Promise<string> {
    const row = await withOrgContext(organisationId, (db) => db.insertInto('user_accounts').values({ organisation_id: organisationId, email: `po-${randomUUID()}@example.com`, password_hash: 'x', is_active: true }).returningAll().executeTakeFirstOrThrow(), pool);
    return row.id;
  }

  async function makeApprovedRequisition(requester: string, approver: string) {
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, { reason: 'PO test requisition', lines: [{ description: 'Widgets', quantity: '100', estimatedUnitPriceMinor: '500' }] }), pool);
    const { approval } = await withOrgContext(orgA, (db) => requisitions.submitRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, req.id, req.version), pool);
    const step = await withOrgContext(orgA, (db) => db.selectFrom('approval_steps').selectAll().where('request_id', '=', approval.requestId).where('status', '=', 'pending').executeTakeFirstOrThrow(), pool);
    await withOrgContext(orgA, (db) => requisitions.decide(ctx(orgA, approver, ['requisite.requisitions.approve'])(db), db, approver, req.id, step.id, 'approve'), pool);
    return req;
  }

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 20 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Requisite PO Org A');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('generates a PO from an approved requisition with correctly computed subtotal/tax/total', async () => {
    const requester = await makeUser(orgA);
    const approver = await makeUser(orgA);
    const req = await makeApprovedRequisition(requester, approver);
    const supplier = await withOrgContext(orgA, (db) => suppliers.createSupplier(ctx(orgA, requester)(db), db, requester, { name: 'PO Test Supplier' }), pool);

    const po = await withOrgContext(orgA, (db) => purchaseOrders.generateFromRequisition(ctx(orgA, requester, ['requisite.purchase-orders.create'])(db), db, requester, req.id, { supplierId: supplier.id, lines: [{ description: 'Widgets', quantityOrdered: '100', unitPriceMinor: '500', taxRateBp: 2000 }] }), pool);

    expect(po.po_number).toMatch(/^PO-\d{6}$/);
    expect(po.subtotal_minor).toBe('50000'); // 100 x £5.00
    expect(po.tax_minor).toBe('10000'); // 20%
    expect(po.total_minor).toBe('60000');
    expect(po.status).toBe('draft');

    const finalReq = await withOrgContext(orgA, (db) => requisitions.getRequisitionRaw(db, orgA, req.id), pool);
    expect(finalReq.status).toBe('ordered');
  });

  it('PO GENERATION WITHOUT APPROVAL: rejected server-side even if called directly (item 41)', async () => {
    const requester = await makeUser(orgA);
    const supplier = await withOrgContext(orgA, (db) => suppliers.createSupplier(ctx(orgA, requester)(db), db, requester, { name: 'Unapproved Test Supplier' }), pool);
    const draftReq = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, { reason: 'Still draft', lines: [{ description: 'X', quantity: '1', estimatedUnitPriceMinor: '100' }] }), pool);

    await expect(
      withOrgContext(orgA, (db) => purchaseOrders.generateFromRequisition(ctx(orgA, requester, ['requisite.purchase-orders.create'])(db), db, requester, draftReq.id, { supplierId: supplier.id, lines: [{ description: 'X', quantityOrdered: '1', unitPriceMinor: '100' }] }), pool),
    ).rejects.toThrow(/must be "approved"/i);
  });

  it('DUPLICATE PO PREVENTION (item 39): two simultaneous PO-generation attempts from the same requisition - only one succeeds', async () => {
    const requester = await makeUser(orgA);
    const approver = await makeUser(orgA);
    const req = await makeApprovedRequisition(requester, approver);
    const supplier = await withOrgContext(orgA, (db) => suppliers.createSupplier(ctx(orgA, requester)(db), db, requester, { name: 'Duplicate PO Test Supplier' }), pool);

    const genInput = { supplierId: supplier.id, lines: [{ description: 'Widgets', quantityOrdered: '100', unitPriceMinor: '500' }] };
    const results = await Promise.allSettled([
      withOrgContext(orgA, (db) => purchaseOrders.generateFromRequisition(ctx(orgA, requester, ['requisite.purchase-orders.create'])(db), db, requester, req.id, genInput), pool),
      withOrgContext(orgA, (db) => purchaseOrders.generateFromRequisition(ctx(orgA, requester, ['requisite.purchase-orders.create'])(db), db, requester, req.id, genInput), pool),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const allPos = await withOrgContext(orgA, (db) => db.selectFrom('requisite_purchase_orders').selectAll().where('source_requisition_id', '=', req.id).execute(), pool);
    expect(allPos).toHaveLength(1);
  });

  it('ISSUE + DUPLICATE ISSUE PREVENTION (item 39): two users issuing the same PO simultaneously - only one succeeds', async () => {
    const requester = await makeUser(orgA);
    const approver = await makeUser(orgA);
    const req = await makeApprovedRequisition(requester, approver);
    const supplier = await withOrgContext(orgA, (db) => suppliers.createSupplier(ctx(orgA, requester)(db), db, requester, { name: 'Issue Test Supplier' }), pool);
    const po = await withOrgContext(orgA, (db) => purchaseOrders.generateFromRequisition(ctx(orgA, requester, ['requisite.purchase-orders.create'])(db), db, requester, req.id, { supplierId: supplier.id, lines: [{ description: 'Widgets', quantityOrdered: '100', unitPriceMinor: '500' }] }), pool);

    const results = await Promise.allSettled([
      withOrgContext(orgA, (db) => purchaseOrders.issue(ctx(orgA, requester, ['requisite.purchase-orders.issue'])(db), db, requester, po.id, po.version), pool),
      withOrgContext(orgA, (db) => purchaseOrders.issue(ctx(orgA, requester, ['requisite.purchase-orders.issue'])(db), db, requester, po.id, po.version), pool),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const finalPo = await withOrgContext(orgA, (db) => purchaseOrders.getPurchaseOrderRaw(db, orgA, po.id), pool);
    expect(finalPo.status).toBe('issued');
  });

  it('ORGANISATION ISOLATION: a PO in org A is invisible from org B', async () => {
    const orgB = await createTestOrg(pool, 'Requisite PO Isolation Org B');
    const requester = await makeUser(orgA);
    const approver = await makeUser(orgA);
    const req = await makeApprovedRequisition(requester, approver);
    const supplier = await withOrgContext(orgA, (db) => suppliers.createSupplier(ctx(orgA, requester)(db), db, requester, { name: 'Isolation Test Supplier' }), pool);
    const po = await withOrgContext(orgA, (db) => purchaseOrders.generateFromRequisition(ctx(orgA, requester, ['requisite.purchase-orders.create'])(db), db, requester, req.id, { supplierId: supplier.id, lines: [{ description: 'X', quantityOrdered: '1', unitPriceMinor: '100' }] }), pool);
    await expect(withOrgContext(orgB, (db) => purchaseOrders.getPurchaseOrderRaw(db, orgB, po.id), pool)).rejects.toThrow(/not found/i);
  });
});
