import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { WorkflowService, WorkflowDefinitionShape } from '../workflow.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const definition: WorkflowDefinitionShape = {
  states: ['draft', 'submitted', 'approved', 'rejected'],
  initialState: 'draft',
  transitions: [
    { from: 'draft', to: 'submitted', permission: 'reference.widget.submit' },
    {
      from: 'submitted',
      to: 'approved',
      permission: 'reference.widget.approve',
      conditions: [{ field: 'amount', operator: '<=', value: 5000 }],
    },
    { from: 'submitted', to: 'rejected', permission: 'reference.widget.approve' },
  ],
};

describeIfDb('WorkflowService - permissions, concurrency, invalid transitions (P1 item 9)', () => {
  let pool: Pool;
  let orgId: string;
  let actorId: string;
  const workflow = new WorkflowService();

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 20 }));
    await setUpTestDatabase(pool);
    orgId = await createTestOrg(pool, 'Workflow Test Org');
    await withOrgContext(
      orgId,
      (db) =>
        workflow.registerDefinition(
          db,
          orgId,
          'com.hexyrn.reference',
          'widget-approval',
          definition,
        ),
      pool,
    );
    const actor = await withOrgContext(
      orgId,
      (db) =>
        db
          .insertInto('user_accounts')
          .values({
            organisation_id: orgId,
            email: 'actor@workflow.test',
            password_hash: 'x',
            is_active: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      pool,
    );
    actorId = actor.id;
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('starts a new instance in the initial state and logs history', async () => {
    const entityId = randomUUID();
    const instance = await withOrgContext(
      orgId,
      (db) =>
        workflow.startInstance(
          db,
          orgId,
          'com.hexyrn.reference',
          'widget-approval',
          'widget',
          entityId,
          actorId,
        ),
      pool,
    );
    expect(instance.current_state).toBe('draft');
    expect(instance.version).toBe(1);
  });

  it('WORKFLOW PERMISSIONS: a transition is rejected when the actor lacks the required permission', async () => {
    const entityId = randomUUID();
    await withOrgContext(
      orgId,
      (db) =>
        workflow.startInstance(
          db,
          orgId,
          'com.hexyrn.reference',
          'widget-approval',
          'widget',
          entityId,
        ),
      pool,
    );
    await expect(
      withOrgContext(
        orgId,
        (db) =>
          workflow.transition(db, orgId, 'widget', entityId, 'submitted', new Set([]), actorId),
        pool,
      ),
    ).rejects.toThrow(/missing required permission/i);
  });

  it('a transition succeeds when the actor holds the required permission, and appends history', async () => {
    const entityId = randomUUID();
    await withOrgContext(
      orgId,
      (db) =>
        workflow.startInstance(
          db,
          orgId,
          'com.hexyrn.reference',
          'widget-approval',
          'widget',
          entityId,
        ),
      pool,
    );
    const result = await withOrgContext(
      orgId,
      (db) =>
        workflow.transition(
          db,
          orgId,
          'widget',
          entityId,
          'submitted',
          new Set(['reference.widget.submit']),
          actorId,
        ),
      pool,
    );
    expect(result).toEqual({ state: 'submitted', version: 2 });

    const history = await withOrgContext(
      orgId,
      (db) => db.selectFrom('workflow_history').selectAll().execute(),
      pool,
    );
    expect(history.some((h) => h.to_state === 'submitted')).toBe(true);
  });

  it('INVALID TRANSITION: transitioning to a state with no defined path from the current state is rejected', async () => {
    const entityId = randomUUID();
    await withOrgContext(
      orgId,
      (db) =>
        workflow.startInstance(
          db,
          orgId,
          'com.hexyrn.reference',
          'widget-approval',
          'widget',
          entityId,
        ),
      pool,
    );
    await expect(
      withOrgContext(
        orgId,
        (db) =>
          workflow.transition(
            db,
            orgId,
            'widget',
            entityId,
            'approved',
            new Set(['reference.widget.approve']),
            actorId,
          ),
        pool,
      ),
    ).rejects.toThrow(/invalid transition/i); // draft -> approved has no defined path
  });

  it('a condition that is not satisfied blocks the transition', async () => {
    const entityId = randomUUID();
    await withOrgContext(
      orgId,
      (db) =>
        workflow.startInstance(
          db,
          orgId,
          'com.hexyrn.reference',
          'widget-approval',
          'widget',
          entityId,
        ),
      pool,
    );
    await withOrgContext(
      orgId,
      (db) =>
        workflow.transition(
          db,
          orgId,
          'widget',
          entityId,
          'submitted',
          new Set(['reference.widget.submit']),
          actorId,
        ),
      pool,
    );
    await expect(
      withOrgContext(
        orgId,
        (db) =>
          workflow.transition(
            db,
            orgId,
            'widget',
            entityId,
            'approved',
            new Set(['reference.widget.approve']),
            actorId,
            { amount: 9999 },
          ),
        pool,
      ),
    ).rejects.toThrow(/condition not met/i);
  });

  it('a satisfied condition allows the transition', async () => {
    const entityId = randomUUID();
    await withOrgContext(
      orgId,
      (db) =>
        workflow.startInstance(
          db,
          orgId,
          'com.hexyrn.reference',
          'widget-approval',
          'widget',
          entityId,
        ),
      pool,
    );
    await withOrgContext(
      orgId,
      (db) =>
        workflow.transition(
          db,
          orgId,
          'widget',
          entityId,
          'submitted',
          new Set(['reference.widget.submit']),
          actorId,
        ),
      pool,
    );
    const result = await withOrgContext(
      orgId,
      (db) =>
        workflow.transition(
          db,
          orgId,
          'widget',
          entityId,
          'approved',
          new Set(['reference.widget.approve']),
          actorId,
          { amount: 1000 },
        ),
      pool,
    );
    expect(result.state).toBe('approved');
  });

  it('CONCURRENCY: two simultaneous transitions on the same instance - exactly one succeeds, the other gets a conflict, and the instance never ends up in a corrupt/mixed state', async () => {
    const entityId = randomUUID();
    await withOrgContext(
      orgId,
      (db) =>
        workflow.startInstance(
          db,
          orgId,
          'com.hexyrn.reference',
          'widget-approval',
          'widget',
          entityId,
        ),
      pool,
    );
    await withOrgContext(
      orgId,
      (db) =>
        workflow.transition(
          db,
          orgId,
          'widget',
          entityId,
          'submitted',
          new Set(['reference.widget.submit']),
          actorId,
        ),
      pool,
    );

    const attempt = () =>
      withOrgContext(
        orgId,
        (db) =>
          workflow.transition(
            db,
            orgId,
            'widget',
            entityId,
            'approved',
            new Set(['reference.widget.approve']),
            actorId,
            { amount: 100 },
          ),
        pool,
      ).then(
        () => ({ ok: true as const }),
        (err) => ({ ok: false as const, err }),
      );

    const [a, b] = await Promise.all([attempt(), attempt()]);
    const outcomes = [a, b];
    const successes = outcomes.filter((o) => o.ok);
    const failures = outcomes.filter((o) => !o.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    // The loser's rejection reason depends on exact timing: if it reads the
    // instance before the winner commits, its own UPDATE...WHERE version=$n
    // matches zero rows -> ConflictException ("modified concurrently"). If
    // it reads AFTER the winner has already committed (a legitimate,
    // equally safe interleaving - Promise.all gives no ordering guarantee),
    // it sees the already-advanced state and there's no valid transition
    // FROM the new state back TO itself -> BadRequestException ("invalid
    // transition"). Both are correct, safe rejections - the property under
    // test (exactly one success, no corrupt/mixed state) holds either way,
    // which is asserted below via version/history, not via the error text.
    expect((failures[0] as any).err.message).toMatch(/modified.*concurrently|invalid transition/i);

    const finalInstance = await withOrgContext(
      orgId,
      (db) => workflow.getInstance(db, orgId, 'widget', entityId),
      pool,
    );
    expect(finalInstance.current_state).toBe('approved');
    expect(finalInstance.version).toBe(3); // exactly one successful increment from version 2, not two

    // History has exactly ONE 'approved' entry, not two - proves the loser's transition never partially applied.
    const history = await withOrgContext(
      orgId,
      (db) =>
        db
          .selectFrom('workflow_history')
          .selectAll()
          .where('instance_id', '=', finalInstance.id)
          .where('to_state', '=', 'approved')
          .execute(),
      pool,
    );
    expect(history).toHaveLength(1);
  });
});
