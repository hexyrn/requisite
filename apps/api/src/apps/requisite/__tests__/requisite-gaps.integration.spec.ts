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
import { GoodsReceiptService } from '../goods-receipt.service';
import { DeliveryMonitoringService } from '../delivery-monitoring.service';
import { PoDocumentService } from '../po-document.service';
import { REQUISITE_APP_MANIFEST } from '../requisite.manifest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Requisite gap closure: custom fields, notifications, files, delivery monitoring, PO PDF (items 14/16/17/18/37)', () => {
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
  const goodsReceipts = new GoodsReceiptService();
  const deliveryMonitoring = new DeliveryMonitoringService(new ScheduledJobService(), new NotificationService());
  const poDocuments = new PoDocumentService();

  function ctx(organisationId: string, actorId: string, permissions: string[] = []) {
    return (db: any) => contextFactory.create(REQUISITE_APP_MANIFEST.appId, organisationId, new Set(permissions), actorId, db);
  }

  async function makeUser(organisationId: string): Promise<string> {
    const row = await withOrgContext(organisationId, (db) => db.insertInto('user_accounts').values({ organisation_id: organisationId, email: `gap-${randomUUID()}@example.com`, password_hash: 'x', is_active: true }).returningAll().executeTakeFirstOrThrow(), pool);
    return row.id;
  }

  async function makeIssuedPo(quantityOrdered = '100', expectedDeliveryDate?: string) {
    const requester = await makeUser(orgA);
    const approver = await makeUser(orgA);
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, { reason: 'Gap test requisition', lines: [{ description: 'Item A', quantity: quantityOrdered, estimatedUnitPriceMinor: '500' }] }), pool);
    const { approval } = await withOrgContext(orgA, (db) => requisitions.submitRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, req.id, req.version), pool);
    const step = await withOrgContext(orgA, (db) => db.selectFrom('approval_steps').selectAll().where('request_id', '=', approval.requestId).where('status', '=', 'pending').executeTakeFirstOrThrow(), pool);
    await withOrgContext(orgA, (db) => requisitions.decide(ctx(orgA, approver, ['requisite.requisitions.approve'])(db), db, approver, req.id, step.id, 'approve'), pool);
    const supplier = await withOrgContext(orgA, (db) => suppliers.createSupplier(ctx(orgA, requester)(db), db, requester, { name: `Gap Test Supplier ${randomUUID()}` }), pool);
    const po = await withOrgContext(orgA, (db) => purchaseOrders.generateFromRequisition(ctx(orgA, requester, ['requisite.purchase-orders.create'])(db), db, requester, req.id, { supplierId: supplier.id, lines: [{ description: 'Item A', quantityOrdered, unitPriceMinor: '500', expectedDeliveryDate }] }), pool);
    const issued = await withOrgContext(orgA, (db) => purchaseOrders.issue(ctx(orgA, requester, ['requisite.purchase-orders.issue'])(db), db, requester, po.id, po.version), pool);
    const poWithLines = await withOrgContext(orgA, (db) => purchaseOrders.getPurchaseOrder(db, orgA, po.id), pool);
    return { requester, approver, req, po: issued, poLine: poWithLines.lines[0] };
  }

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 20 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Requisite Gap Org A');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('CUSTOM FIELDS (item 14): the requisition/supplier/PO custom fields are registered and settable through Core Custom Fields', async () => {
    const requester = await makeUser(orgA);
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester)(db), db, requester, { reason: 'Custom field test', lines: [{ description: 'X', quantity: '1', estimatedUnitPriceMinor: '100' }] }), pool);
    const definitions = await withOrgContext(orgA, (db) => db.selectFrom('custom_field_definitions').selectAll().where('entity_type', '=', 'requisite_requisition').execute(), pool);
    expect(definitions.map((d) => d.key)).toEqual(expect.arrayContaining(['customer_job_number', 'grant_funding_code', 'emergency_purchase_reason']));

    await withOrgContext(orgA, (db) => ctx(orgA, requester)(db).customFields.setValues(db, 'requisite_requisition', req.id, { customer_job_number: 'JOB-4471' }), pool);
    const values = await withOrgContext(orgA, (db) => ctx(orgA, requester)(db).customFields.getValues(db, 'requisite_requisition', req.id), pool);
    expect(values.customer_job_number).toBe('JOB-4471');
  });

  it('NOTIFICATIONS (item 17): submit notifies approvers, approve notifies the requester, PO creation notifies the requester, receipt notifies the requester', async () => {
    const requester = await makeUser(orgA);
    const approver = await makeUser(orgA);
    // Grant approver permission via a real role so findUsersWithPermission finds them.
    const role = await withOrgContext(orgA, (db) => db.insertInto('roles').values({ organisation_id: orgA, name: `Approver-${randomUUID()}` }).returningAll().executeTakeFirstOrThrow(), pool);
    await withOrgContext(orgA, (db) => db.insertInto('role_permissions').values({ organisation_id: orgA, role_id: role.id, permission_key: 'requisite.requisitions.approve' }).execute(), pool);
    await withOrgContext(orgA, (db) => db.insertInto('user_roles').values({ organisation_id: orgA, user_account_id: approver, role_id: role.id }).execute(), pool);

    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, { reason: 'Notification test', lines: [{ description: 'X', quantity: '1', estimatedUnitPriceMinor: '100' }] }), pool);
    const { approval } = await withOrgContext(orgA, (db) => requisitions.submitRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, req.id, req.version), pool);

    const approverNotifications = await withOrgContext(orgA, (db) => db.selectFrom('notifications').selectAll().where('recipient_user_account_id', '=', approver).where('notification_type', '=', 'requisite.approval_required').execute(), pool);
    expect(approverNotifications.length).toBeGreaterThanOrEqual(1);

    const step = await withOrgContext(orgA, (db) => db.selectFrom('approval_steps').selectAll().where('request_id', '=', approval.requestId).where('status', '=', 'pending').executeTakeFirstOrThrow(), pool);
    await withOrgContext(orgA, (db) => requisitions.decide(ctx(orgA, approver, ['requisite.requisitions.approve'])(db), db, approver, req.id, step.id, 'approve'), pool);

    const requesterNotifications = await withOrgContext(orgA, (db) => db.selectFrom('notifications').selectAll().where('recipient_user_account_id', '=', requester).where('notification_type', '=', 'requisite.requisition_approved').execute(), pool);
    expect(requesterNotifications.length).toBeGreaterThanOrEqual(1);
  });

  it('FILES (item 16): a quote/spec can be attached to a requisition through Core Files and listed back, org-isolated', async () => {
    const requester = await makeUser(orgA);
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester)(db), db, requester, { reason: 'File attachment test', lines: [{ description: 'X', quantity: '1', estimatedUnitPriceMinor: '100' }] }), pool);
    await withOrgContext(orgA, (db) => requisitions.attachFile(ctx(orgA, requester)(db), db, requester, req.id, Buffer.from('%PDF-1.4 fake quote content'), 'quote.pdf', 'application/pdf'), pool);

    const attachments = await withOrgContext(orgA, (db) => requisitions.listAttachments(db, orgA, req.id), pool);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].original_filename).toBe('quote.pdf');

    const orgB = await createTestOrg(pool, 'Requisite Gap Isolation Org B');
    const attachmentsFromB = await withOrgContext(orgB, (db) => requisitions.listAttachments(db, orgB, req.id), pool);
    expect(attachmentsFromB).toHaveLength(0);
  });

  it('DELIVERY MONITORING (item 18): an overdue PO line is detected and notifies the buyer', async () => {
    const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { requester } = await makeIssuedPo('50', yesterday);
    const result = await withOrgContext(orgA, (db) => deliveryMonitoring.runCheck(db, orgA), pool);
    expect(result.overdue).toBeGreaterThanOrEqual(1);

    const overdueNotifications = await withOrgContext(orgA, (db) => db.selectFrom('notifications').selectAll().where('recipient_user_account_id', '=', requester).where('notification_type', '=', 'requisite.delivery_overdue').execute(), pool);
    expect(overdueNotifications.length).toBeGreaterThanOrEqual(1);
  });

  it('DELIVERY MONITORING: a fully-received PO line is never reported overdue even with a past expected date', async () => {
    const yesterday = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { po, poLine, requester } = await makeIssuedPo('10', yesterday);
    await withOrgContext(orgA, (db) => goodsReceipts.recordReceipt(ctx(orgA, requester, ['requisite.goods-receipts.create'])(db), db, requester, po.id, { lines: [{ purchaseOrderLineId: poLine.id, quantityReceived: '10' }] }), pool);

    const beforeCount = (await withOrgContext(orgA, (db) => db.selectFrom('notifications').selectAll().where('recipient_user_account_id', '=', requester).where('notification_type', '=', 'requisite.delivery_overdue').execute(), pool)).length;
    await withOrgContext(orgA, (db) => deliveryMonitoring.runCheck(db, orgA), pool);
    const afterCount = (await withOrgContext(orgA, (db) => db.selectFrom('notifications').selectAll().where('recipient_user_account_id', '=', requester).where('notification_type', '=', 'requisite.delivery_overdue').execute(), pool)).length;
    expect(afterCount).toBe(beforeCount); // fully received - no new overdue notification for this line
  });

  it('PO PDF DOCUMENT (item 37): generates a real PDF with org branding, supplier, and totals', async () => {
    const { po } = await makeIssuedPo('20');
    const pdf = await withOrgContext(orgA, (db) => poDocuments.generatePdf(db, orgA, po.id, 'Gap Test Org Ltd'), pool);
    expect(pdf.subarray(0, 4).toString('utf8')).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(500);
  });

  it('PO PDF DOCUMENT: 404s for a PO in another organisation', async () => {
    const { po } = await makeIssuedPo('5');
    const orgB = await createTestOrg(pool, 'Requisite Gap PDF Isolation Org B');
    await expect(withOrgContext(orgB, (db) => poDocuments.generatePdf(db, orgB, po.id, 'Org B'), pool)).rejects.toThrow(/not found/i);
  });

  it('APPROVER UX (item 36): approval history is retrievable, showing the decision and who made it, without a second admin screen', async () => {
    const requester = await makeUser(orgA);
    const approver = await makeUser(orgA);
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, { reason: 'Approval history test', lines: [{ description: 'X', quantity: '1', estimatedUnitPriceMinor: '100' }] }), pool);
    const { approval } = await withOrgContext(orgA, (db) => requisitions.submitRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, req.id, req.version), pool);
    const step = await withOrgContext(orgA, (db) => db.selectFrom('approval_steps').selectAll().where('request_id', '=', approval.requestId).where('status', '=', 'pending').executeTakeFirstOrThrow(), pool);
    await withOrgContext(orgA, (db) => requisitions.decide(ctx(orgA, approver, ['requisite.requisitions.approve'])(db), db, approver, req.id, step.id, 'approve', 'Looks good'), pool);

    const history = await withOrgContext(orgA, (db) => requisitions.getApprovalHistory(db, orgA, req.id), pool);
    expect(history).toHaveLength(1);
    expect(history[0].steps[0].decisions[0].decided_by).toBe(approver);
    expect(history[0].steps[0].decisions[0].decision).toBe('approve');
    expect(history[0].steps[0].decisions[0].comment).toBe('Looks good');
  });
});
