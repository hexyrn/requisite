import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { NotificationService } from '../notification.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('NotificationService - isolation and preferences (P1 item 12)', () => {
  let pool: Pool;
  let orgA: string;
  let orgB: string;
  let userA: string;
  let userA2: string;
  const notifications = new NotificationService();

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Notif Org A');
    orgB = await createTestOrg(pool, 'Notif Org B');
    const u1 = await withOrgContext(orgA, (db) => db.insertInto('user_accounts').values({ organisation_id: orgA, email: 'recipient@notif.test', password_hash: 'x', is_active: true }).returningAll().executeTakeFirstOrThrow(), pool);
    userA = u1.id;
    const u2 = await withOrgContext(orgA, (db) => db.insertInto('user_accounts').values({ organisation_id: orgA, email: 'other-user@notif.test', password_hash: 'x', is_active: true }).returningAll().executeTakeFirstOrThrow(), pool);
    userA2 = u2.id;
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('sends a notification and it appears unread for the recipient', async () => {
    await withOrgContext(orgA, (db) => notifications.send(db, orgA, 'com.hexyrn.reference', userA, 'widget.approved', 'Your widget was approved', 'Great news!'), pool);
    const list = await withOrgContext(orgA, (db) => notifications.listForUser(db, orgA, userA), pool);
    expect(list).toHaveLength(1);
    expect(list[0].read_at).toBeNull();
  });

  it('markRead is scoped to the actual recipient - another user in the same org cannot mark someone else\'s notification read (IDOR guard)', async () => {
    const list = await withOrgContext(orgA, (db) => notifications.listForUser(db, orgA, userA), pool);
    const notificationId = list[0].id;

    await withOrgContext(orgA, (db) => notifications.markRead(db, orgA, userA2, notificationId), pool); // wrong user - should silently no-op, not mark it read
    const stillUnread = await withOrgContext(orgA, (db) => notifications.listForUser(db, orgA, userA, true), pool);
    expect(stillUnread.some((n) => n.id === notificationId)).toBe(true);

    await withOrgContext(orgA, (db) => notifications.markRead(db, orgA, userA, notificationId), pool); // correct user
    const nowRead = await withOrgContext(orgA, (db) => notifications.listForUser(db, orgA, userA, true), pool);
    expect(nowRead.some((n) => n.id === notificationId)).toBe(false);
  });

  it('NOTIFICATION ISOLATION: a notification sent in org A is never visible from org B, even to a same-email-pattern user', async () => {
    const userB = await withOrgContext(orgB, (db) => db.insertInto('user_accounts').values({ organisation_id: orgB, email: 'recipient@notif.test', password_hash: 'x', is_active: true }).returningAll().executeTakeFirstOrThrow(), pool);
    const listB = await withOrgContext(orgB, (db) => notifications.listForUser(db, orgB, userB.id), pool);
    expect(listB).toHaveLength(0); // org A's notifications for a same-email user never leak into org B
  });

  it('respects a disabled channel preference - a disabled channel is excluded from delivery_state', async () => {
    await withOrgContext(orgA, (db) => notifications.setPreference(db, orgA, userA, 'widget.approved', 'email', false), pool);
    const id = await withOrgContext(orgA, (db) => notifications.send(db, orgA, 'com.hexyrn.reference', userA, 'widget.approved', 'Another', 'body'), pool);
    const row = await withOrgContext(orgA, (db) => db.selectFrom('notifications').selectAll().where('id', '=', id).executeTakeFirstOrThrow(), pool);
    expect(row.channels).not.toContain('email');
    expect(row.channels).toContain('in_app');
  });
});
