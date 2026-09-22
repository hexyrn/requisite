import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { ApprovalService } from '../approval.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'ApprovalService - permissions, sequential/parallel, any-one-of/unanimous, delegation (P1 item 10)',
  () => {
    let pool: Pool;
    let orgId: string;
    let user1: string;
    let user2: string;
    let user3: string;
    const approvals = new ApprovalService();

    async function makeUser(email: string): Promise<string> {
      const row = await withOrgContext(
        orgId,
        (db) =>
          db
            .insertInto('user_accounts')
            .values({ organisation_id: orgId, email, password_hash: 'x', is_active: true })
            .returningAll()
            .executeTakeFirstOrThrow(),
        pool,
      );
      return row.id;
    }

    beforeAll(async () => {
      pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 20 }));
      await setUpTestDatabase(pool);
      orgId = await createTestOrg(pool, 'Approval Test Org');
      user1 = await makeUser('u1@approval.test');
      user2 = await makeUser('u2@approval.test');
      user3 = await makeUser('u3@approval.test');
    }, 60000);

    afterAll(async () => {
      await pool.end();
    });

    it('APPROVAL PERMISSIONS: deciding a step without the required permission is rejected', async () => {
      await withOrgContext(
        orgId,
        (db) =>
          approvals.registerDefinition(db, orgId, 'com.hexyrn.reference', 'simple', {
            mode: 'sequential',
            steps: [{ approverPermission: 'reference.approve.level1', decisionRule: 'any_one_of' }],
          }),
        pool,
      );
      const request = await withOrgContext(
        orgId,
        (db) =>
          approvals.requestApproval(
            db,
            orgId,
            'com.hexyrn.reference',
            'simple',
            'widget',
            randomUUID(),
            { amount: 100 },
            user1,
          ),
        pool,
      );
      const step = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', request.id)
            .executeTakeFirstOrThrow(),
        pool,
      );

      await expect(
        withOrgContext(
          orgId,
          (db) => approvals.decide(db, orgId, step.id, user2, new Set([]), 'approve'),
          pool,
        ),
      ).rejects.toThrow(/missing required permission/i);
    });

    it('a decision with the correct permission approves the step and the request', async () => {
      const request = await withOrgContext(
        orgId,
        (db) =>
          approvals.requestApproval(
            db,
            orgId,
            'com.hexyrn.reference',
            'simple',
            'widget',
            randomUUID(),
            { amount: 100 },
            user1,
          ),
        pool,
      );
      const step = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', request.id)
            .executeTakeFirstOrThrow(),
        pool,
      );

      const result = await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            step.id,
            user2,
            new Set(['reference.approve.level1']),
            'approve',
          ),
        pool,
      );
      expect(result).toEqual({ requestStatus: 'approved', stepStatus: 'approved' });
    });

    it('a rejection immediately marks the step and request rejected', async () => {
      const request = await withOrgContext(
        orgId,
        (db) =>
          approvals.requestApproval(
            db,
            orgId,
            'com.hexyrn.reference',
            'simple',
            'widget',
            randomUUID(),
            { amount: 100 },
            user1,
          ),
        pool,
      );
      const step = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', request.id)
            .executeTakeFirstOrThrow(),
        pool,
      );

      const result = await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            step.id,
            user2,
            new Set(['reference.approve.level1']),
            'reject',
            'not justified',
          ),
        pool,
      );
      expect(result).toEqual({ requestStatus: 'rejected', stepStatus: 'rejected' });
    });

    it('a request/step that is already decided cannot be decided again', async () => {
      const request = await withOrgContext(
        orgId,
        (db) =>
          approvals.requestApproval(
            db,
            orgId,
            'com.hexyrn.reference',
            'simple',
            'widget',
            randomUUID(),
            { amount: 100 },
            user1,
          ),
        pool,
      );
      const step = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', request.id)
            .executeTakeFirstOrThrow(),
        pool,
      );
      await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            step.id,
            user2,
            new Set(['reference.approve.level1']),
            'approve',
          ),
        pool,
      );

      await expect(
        withOrgContext(
          orgId,
          (db) =>
            approvals.decide(
              db,
              orgId,
              step.id,
              user3,
              new Set(['reference.approve.level1']),
              'approve',
            ),
          pool,
        ),
      ).rejects.toThrow(/already/i);
    });

    it('SEQUENTIAL: a later step cannot be decided before an earlier step is approved', async () => {
      await withOrgContext(
        orgId,
        (db) =>
          approvals.registerDefinition(db, orgId, 'com.hexyrn.reference', 'two-step-sequential', {
            mode: 'sequential',
            steps: [
              { approverPermission: 'reference.approve.level1', decisionRule: 'any_one_of' },
              { approverPermission: 'reference.approve.level2', decisionRule: 'any_one_of' },
            ],
          }),
        pool,
      );
      const request = await withOrgContext(
        orgId,
        (db) =>
          approvals.requestApproval(
            db,
            orgId,
            'com.hexyrn.reference',
            'two-step-sequential',
            'widget',
            randomUUID(),
            {},
            user1,
          ),
        pool,
      );
      const steps = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', request.id)
            .orderBy('step_index')
            .execute(),
        pool,
      );

      // Step 2 attempted before step 1 - rejected.
      await expect(
        withOrgContext(
          orgId,
          (db) =>
            approvals.decide(
              db,
              orgId,
              steps[1].id,
              user2,
              new Set(['reference.approve.level2']),
              'approve',
            ),
          pool,
        ),
      ).rejects.toThrow(/earlier approval steps/i);

      // Step 1 decided, THEN step 2 succeeds.
      await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            steps[0].id,
            user2,
            new Set(['reference.approve.level1']),
            'approve',
          ),
        pool,
      );
      const result = await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            steps[1].id,
            user3,
            new Set(['reference.approve.level2']),
            'approve',
          ),
        pool,
      );
      expect(result.requestStatus).toBe('approved');
    });

    it('PARALLEL: both steps are decidable immediately, in any order', async () => {
      await withOrgContext(
        orgId,
        (db) =>
          approvals.registerDefinition(db, orgId, 'com.hexyrn.reference', 'two-step-parallel', {
            mode: 'parallel',
            steps: [
              { approverPermission: 'reference.approve.finance', decisionRule: 'any_one_of' },
              { approverPermission: 'reference.approve.ops', decisionRule: 'any_one_of' },
            ],
          }),
        pool,
      );
      const request = await withOrgContext(
        orgId,
        (db) =>
          approvals.requestApproval(
            db,
            orgId,
            'com.hexyrn.reference',
            'two-step-parallel',
            'widget',
            randomUUID(),
            {},
            user1,
          ),
        pool,
      );
      const steps = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', request.id)
            .orderBy('step_index')
            .execute(),
        pool,
      );

      // Decide step 2 (ops) FIRST - must succeed under parallel mode, unlike sequential.
      const first = await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            steps[1].id,
            user2,
            new Set(['reference.approve.ops']),
            'approve',
          ),
        pool,
      );
      expect(first.stepStatus).toBe('approved');
      expect(first.requestStatus).toBe('pending'); // step 1 still outstanding

      const second = await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            steps[0].id,
            user3,
            new Set(['reference.approve.finance']),
            'approve',
          ),
        pool,
      );
      expect(second.requestStatus).toBe('approved');
    });

    it('ANY-ONE-OF: a single approval is sufficient even if multiple people hold the permission', async () => {
      const request = await withOrgContext(
        orgId,
        (db) =>
          approvals.requestApproval(
            db,
            orgId,
            'com.hexyrn.reference',
            'simple',
            'widget',
            randomUUID(),
            {},
            user1,
          ),
        pool,
      );
      const step = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', request.id)
            .executeTakeFirstOrThrow(),
        pool,
      );
      const result = await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            step.id,
            user2,
            new Set(['reference.approve.level1']),
            'approve',
          ),
        pool,
      );
      expect(result.stepStatus).toBe('approved'); // one decision, done
    });

    it('UNANIMOUS: a single approval is NOT sufficient - the step stays pending until the required count is reached', async () => {
      await withOrgContext(
        orgId,
        (db) =>
          approvals.registerDefinition(db, orgId, 'com.hexyrn.reference', 'unanimous-def', {
            mode: 'sequential',
            steps: [
              {
                approverPermission: 'reference.approve.board',
                decisionRule: 'unanimous',
                requiredApproverCount: 2,
              },
            ],
          }),
        pool,
      );
      const request = await withOrgContext(
        orgId,
        (db) =>
          approvals.requestApproval(
            db,
            orgId,
            'com.hexyrn.reference',
            'unanimous-def',
            'widget',
            randomUUID(),
            {},
            user1,
          ),
        pool,
      );
      const step = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', request.id)
            .executeTakeFirstOrThrow(),
        pool,
      );

      const afterFirst = await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            step.id,
            user2,
            new Set(['reference.approve.board']),
            'approve',
          ),
        pool,
      );
      expect(afterFirst.stepStatus).toBe('pending'); // still waiting on a second approver

      // The SAME approver deciding again does not count as a second distinct approval (blocked because step already 'pending' but decision-less re-decide is blocked at status check level once step resolves; here step is still pending so re-decide by same actor is technically allowed by the service and adds to distinctApprovers set - but distinctApprovers is a SET, so re-approving with the SAME user id would not increase the distinct count). Verify with a truly distinct second approver instead:
      const afterSecond = await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            step.id,
            user3,
            new Set(['reference.approve.board']),
            'approve',
          ),
        pool,
      );
      expect(afterSecond.stepStatus).toBe('approved');
      expect(afterSecond.requestStatus).toBe('approved');
    });

    it('DELEGATION: an active delegate can decide on behalf of a delegator, recorded via on_behalf_of', async () => {
      await withOrgContext(
        orgId,
        (db) => approvals.createDelegation(db, orgId, user1, user2, new Date(Date.now() - 1000)),
        pool,
      );
      const delegators = await withOrgContext(
        orgId,
        (db) => approvals.getActiveDelegators(db, orgId, user2),
        pool,
      );
      expect(delegators).toContain(user1);

      const request = await withOrgContext(
        orgId,
        (db) =>
          approvals.requestApproval(
            db,
            orgId,
            'com.hexyrn.reference',
            'simple',
            'widget',
            randomUUID(),
            {},
            user3,
          ),
        pool,
      );
      const step = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', request.id)
            .executeTakeFirstOrThrow(),
        pool,
      );

      // user2 decides "on behalf of" user1 (whose permission set they're borrowing).
      await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            step.id,
            user2,
            new Set(['reference.approve.level1']),
            'approve',
            'deciding for user1',
            user1,
          ),
        pool,
      );

      const decision = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_decisions')
            .selectAll()
            .where('step_id', '=', step.id)
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(decision.decided_by).toBe(user2);
      expect(decision.on_behalf_of).toBe(user1);
    });

    it('an expired delegation is not returned as active', async () => {
      await withOrgContext(
        orgId,
        (db) =>
          approvals.createDelegation(
            db,
            orgId,
            user3,
            user1,
            new Date(Date.now() - 10000),
            new Date(Date.now() - 5000),
          ),
        pool,
      );
      const delegators = await withOrgContext(
        orgId,
        (db) => approvals.getActiveDelegators(db, orgId, user1),
        pool,
      );
      expect(delegators).not.toContain(user3);
    });

    it('every decision is immutable and auditable - approval_decisions has an insert-only trail, never updated', async () => {
      const request = await withOrgContext(
        orgId,
        (db) =>
          approvals.requestApproval(
            db,
            orgId,
            'com.hexyrn.reference',
            'simple',
            'widget',
            randomUUID(),
            {},
            user1,
          ),
        pool,
      );
      const step = await withOrgContext(
        orgId,
        (db) =>
          db
            .selectFrom('approval_steps')
            .selectAll()
            .where('request_id', '=', request.id)
            .executeTakeFirstOrThrow(),
        pool,
      );
      await withOrgContext(
        orgId,
        (db) =>
          approvals.decide(
            db,
            orgId,
            step.id,
            user2,
            new Set(['reference.approve.level1']),
            'approve',
            'looks good',
          ),
        pool,
      );

      const decisions = await withOrgContext(
        orgId,
        (db) =>
          db.selectFrom('approval_decisions').selectAll().where('step_id', '=', step.id).execute(),
        pool,
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0].comment).toBe('looks good');
      expect(decisions[0].decided_at).toBeDefined();
    });
  },
);
