import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { ChecklistService } from '../checklist.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('ChecklistService (P1 item 11)', () => {
  let pool: Pool;
  let orgId: string;
  let userId: string;
  const checklists = new ChecklistService();

  const definition = {
    sections: [
      {
        key: 'inspection',
        label: 'Inspection',
        questions: [
          { key: 'exterior_ok', label: 'Exterior OK?', type: 'pass_fail' as const, required: true, scoreWeight: 1, flagsIssueOnFail: true },
          { key: 'notes', label: 'Notes', type: 'comment' as const },
        ],
      },
    ],
  };

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgId = await createTestOrg(pool, 'Checklist Test Org');
    const user = await withOrgContext(orgId, (db) => db.insertInto('user_accounts').values({ organisation_id: orgId, email: 'inspector@checklist.test', password_hash: 'x', is_active: true }).returningAll().executeTakeFirstOrThrow(), pool);
    userId = user.id;
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('creates a template, starts an instance, answers questions, and completes with a score', async () => {
    const template = await withOrgContext(orgId, (db) => checklists.createTemplate(db, orgId, 'com.hexyrn.reference', 'widget-inspection', 'Widget Inspection', definition), pool);
    const instance = await withOrgContext(orgId, (db) => checklists.startInstance(db, orgId, template.id, 'widget', randomUUID(), userId), pool);
    expect(instance.status).toBe('in_progress');

    await withOrgContext(orgId, (db) => checklists.answer(db, orgId, instance.id, 'exterior_ok', 'pass', userId), pool);
    await withOrgContext(orgId, (db) => checklists.answer(db, orgId, instance.id, 'notes', 'Looks fine', userId), pool);

    const { score } = await withOrgContext(orgId, (db) => checklists.complete(db, orgId, instance.id), pool);
    expect(score).toBe(100);
  });

  it('refuses to complete when a required question is unanswered', async () => {
    const template = await withOrgContext(orgId, (db) => checklists.createTemplate(db, orgId, 'com.hexyrn.reference', 'widget-inspection', 'Widget Inspection', definition), pool);
    const instance = await withOrgContext(orgId, (db) => checklists.startInstance(db, orgId, template.id, 'widget', randomUUID(), userId), pool);
    await expect(withOrgContext(orgId, (db) => checklists.complete(db, orgId, instance.id), pool)).rejects.toThrow(/required/i);
  });

  it('scoring reflects failed answers', async () => {
    const template = await withOrgContext(orgId, (db) => checklists.createTemplate(db, orgId, 'com.hexyrn.reference', 'widget-inspection', 'Widget Inspection', definition), pool);
    const instance = await withOrgContext(orgId, (db) => checklists.startInstance(db, orgId, template.id, 'widget', randomUUID(), userId), pool);
    await withOrgContext(orgId, (db) => checklists.answer(db, orgId, instance.id, 'exterior_ok', 'fail', userId, 'issue-123'), pool);
    const { score } = await withOrgContext(orgId, (db) => checklists.complete(db, orgId, instance.id), pool);
    expect(score).toBe(0);

    const response = await withOrgContext(orgId, (db) => db.selectFrom('checklist_responses').selectAll().where('instance_id', '=', instance.id).where('question_key', '=', 'exterior_ok').executeTakeFirstOrThrow(), pool);
    expect(response.resulting_issue_ref).toBe('issue-123'); // app-owned extensibility pointer
  });

  it('cannot answer a completed checklist', async () => {
    const template = await withOrgContext(orgId, (db) => checklists.createTemplate(db, orgId, 'com.hexyrn.reference', 'widget-inspection', 'Widget Inspection', definition), pool);
    const instance = await withOrgContext(orgId, (db) => checklists.startInstance(db, orgId, template.id, 'widget', randomUUID(), userId), pool);
    await withOrgContext(orgId, (db) => checklists.answer(db, orgId, instance.id, 'exterior_ok', 'pass', userId), pool);
    await withOrgContext(orgId, (db) => checklists.complete(db, orgId, instance.id), pool);
    await expect(withOrgContext(orgId, (db) => checklists.answer(db, orgId, instance.id, 'notes', 'too late', userId), pool)).rejects.toThrow(/already been completed/i);
  });
});
