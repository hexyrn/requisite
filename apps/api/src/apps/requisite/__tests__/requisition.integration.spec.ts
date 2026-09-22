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
import { RequisitionService } from '../requisition.service';
import { REQUISITE_APP_MANIFEST } from '../requisite.manifest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('Requisite RequisitionService - create/submit/approve, edit restrictions, concurrency (items 4/6/7/39/42)', () => {
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
  const onboarding = new RequisiteOnboardingService(new NumberingService(), new FormService(), new WorkflowService(), new ApprovalService());
  const requisitions = new RequisitionService(onboarding);

  function ctx(organisationId: string, actorId: string, permissions: string[] = []) {
    return (db: any) => contextFactory.create(REQUISITE_APP_MANIFEST.appId, organisationId, new Set(permissions), actorId, db);
  }

  async function makeUser(organisationId: string): Promise<string> {
    const row = await withOrgContext(organisationId, (db) => db.insertInto('user_accounts').values({ organisation_id: organisationId, email: `req-${randomUUID()}@example.com`, password_hash: 'x', is_active: true }).returningAll().executeTakeFirstOrThrow(), pool);
    return row.id;
  }

  const sampleLines = [{ description: 'Steel Brackets', quantity: '10', unit: 'each', estimatedUnitPriceMinor: '1250' }]; // 10 x £12.50 = £125.00

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 20 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Requisite Requisition Org A');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('creates a requisition with a Core-numbered requisition number and correctly computed estimated total (money, item 38)', async () => {
    const requester = await makeUser(orgA);
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, { reason: 'Replacement stock', lines: sampleLines }), pool);
    expect(req.requisition_number).toMatch(/^REQ-\d{6}$/);
    expect(req.estimated_value_minor).toBe('12500');
    expect(req.status).toBe('draft');
    expect(req.lines).toHaveLength(1);
    expect(req.lines[0].estimated_total_minor).toBe('12500');
  });

  it('rejects a requisition with no lines', async () => {
    const requester = await makeUser(orgA);
    await expect(withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester)(db), db, requester, { reason: 'Nothing to buy', lines: [] }), pool)).rejects.toThrow(/at least one line/i);
  });

  it('full lifecycle: submit -> approve -> workflow state reflects approval', async () => {
    const requester = await makeUser(orgA);
    const approver = await makeUser(orgA);
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, { reason: 'Office supplies', lines: sampleLines }), pool);

    const { approval } = await withOrgContext(orgA, (db) => requisitions.submitRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, req.id, req.version), pool);
    expect(approval.status).toBe('pending');

    const pendingStep = await withOrgContext(orgA, (db) => db.selectFrom('approval_steps').selectAll().where('request_id', '=', approval.requestId).where('status', '=', 'pending').executeTakeFirstOrThrow(), pool);

    const decision = await withOrgContext(orgA, (db) => requisitions.decide(ctx(orgA, approver, ['requisite.requisitions.approve'])(db), db, approver, req.id, pendingStep.id, 'approve'), pool);
    expect(decision.requestStatus).toBe('approved');

    const finalReq = await withOrgContext(orgA, (db) => requisitions.getRequisitionRaw(db, orgA, req.id), pool);
    expect(finalReq.status).toBe('approved');
  });

  it('EDIT RESTRICTION: a submitted requisition can no longer be edited (item 39 domain invariant)', async () => {
    const requester = await makeUser(orgA);
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, { reason: 'Test edit restriction', lines: sampleLines }), pool);
    await withOrgContext(orgA, (db) => requisitions.submitRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, req.id, req.version), pool);

    await expect(withOrgContext(orgA, (db) => requisitions.editRequisition(db, orgA, req.id, req.version, { reason: 'Trying to sneak an edit in' }), pool)).rejects.toThrow(/only draft requisitions/i);
  });

  it('CONCURRENCY (item 39): editing a requisition while it is concurrently being submitted - one wins, the other gets a real conflict, never a silently lost update', async () => {
    const requester = await makeUser(orgA);
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, { reason: 'Race condition test', lines: sampleLines }), pool);

    const results = await Promise.allSettled([
      withOrgContext(orgA, (db) => requisitions.editRequisition(db, orgA, req.id, req.version, { reason: 'Edited concurrently' }), pool),
      withOrgContext(orgA, (db) => requisitions.submitRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, req.id, req.version), pool),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exactly one of the two concurrent operations wins the version race;
    // the other must fail with a real conflict (ConflictException) or a
    // domain-status rejection (ForbiddenException, if it observed the
    // already-submitted state) - never both silently "succeeding" against
    // stale data.
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
  });

  it('CANCELLATION: a cancelled requisition cannot later be approved (item 39)', async () => {
    const requester = await makeUser(orgA);
    const approver = await makeUser(orgA);
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit', 'requisite.requisitions.cancel'])(db), db, requester, { reason: 'Will be cancelled', lines: sampleLines }), pool);
    const { approval } = await withOrgContext(orgA, (db) => requisitions.submitRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, req.id, req.version), pool);
    const pendingStep = await withOrgContext(orgA, (db) => db.selectFrom('approval_steps').selectAll().where('request_id', '=', approval.requestId).where('status', '=', 'pending').executeTakeFirstOrThrow(), pool);

    await withOrgContext(orgA, (db) => requisitions.cancelRequisition(ctx(orgA, requester, ['requisite.requisitions.cancel'])(db), db, requester, req.id), pool);

    await expect(withOrgContext(orgA, (db) => requisitions.decide(ctx(orgA, approver, ['requisite.requisitions.approve'])(db), db, approver, req.id, pendingStep.id, 'approve'), pool)).rejects.toThrow(/cancelled/i);
  });

  it('ORGANISATION ISOLATION: a requisition in org A is invisible from org B', async () => {
    const orgB = await createTestOrg(pool, 'Requisite Isolation Org B');
    const requester = await makeUser(orgA);
    const req = await withOrgContext(orgA, (db) => requisitions.createRequisition(ctx(orgA, requester, ['requisite.requisitions.submit'])(db), db, requester, { reason: 'Isolation test', lines: sampleLines }), pool);
    await expect(withOrgContext(orgB, (db) => requisitions.getRequisitionRaw(db, orgB, req.id), pool)).rejects.toThrow(/not found/i);
  });
});
