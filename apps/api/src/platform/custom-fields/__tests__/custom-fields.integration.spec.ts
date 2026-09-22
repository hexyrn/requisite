import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { CustomFieldService } from '../custom-field.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('CustomFieldService - type validation and organisation isolation (P1 item 5)', () => {
  let pool: Pool;
  let orgA: string;
  let orgB: string;
  const customFields = new CustomFieldService();

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'CF Org A');
    orgB = await createTestOrg(pool, 'CF Org B');

    await withOrgContext(orgA, (db) => customFields.defineField(db, orgA, { appId: 'com.hexyrn.reference', entityType: 'widget', key: 'warranty_status', label: 'Warranty', fieldType: 'select', selectOptions: ['active', 'expired'] }), pool);
    await withOrgContext(orgA, (db) => customFields.defineField(db, orgA, { appId: 'com.hexyrn.reference', entityType: 'widget', key: 'purchase_cost', label: 'Cost', fieldType: 'decimal' }), pool);
    await withOrgContext(orgA, (db) => customFields.defineField(db, orgA, { appId: 'com.hexyrn.reference', entityType: 'widget', key: 'is_active', label: 'Active', fieldType: 'boolean' }), pool);
    await withOrgContext(orgA, (db) => customFields.defineField(db, orgA, { appId: 'com.hexyrn.reference', entityType: 'widget', key: 'delivery_date', label: 'Delivery', fieldType: 'date' }), pool);
    await withOrgContext(orgA, (db) => customFields.defineField(db, orgA, { appId: 'com.hexyrn.reference', entityType: 'widget', key: 'contact_email', label: 'Email', fieldType: 'email' }), pool);
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('TYPE VALIDATION: accepts correctly-typed values', async () => {
    await withOrgContext(
      orgA,
      (db) => customFields.setValues(db, orgA, 'widget', randomUUID(), { warranty_status: 'active', purchase_cost: 1250.5, is_active: true, delivery_date: '2026-01-01', contact_email: 'a@b.com' }),
      pool,
    );
  });

  it('TYPE VALIDATION: rejects a select value outside the configured options', async () => {
    await expect(withOrgContext(orgA, (db) => customFields.setValues(db, orgA, 'widget', randomUUID(), { warranty_status: 'bogus' }), pool)).rejects.toThrow(/configured options/i);
  });

  it('TYPE VALIDATION: rejects a non-numeric decimal value', async () => {
    await expect(withOrgContext(orgA, (db) => customFields.setValues(db, orgA, 'widget', randomUUID(), { purchase_cost: 'not-a-number' }), pool)).rejects.toThrow(/must be a number/i);
  });

  it('TYPE VALIDATION: rejects a non-boolean for a boolean field', async () => {
    await expect(withOrgContext(orgA, (db) => customFields.setValues(db, orgA, 'widget', randomUUID(), { is_active: 'yes' }), pool)).rejects.toThrow(/must be a boolean/i);
  });

  it('TYPE VALIDATION: rejects an invalid date', async () => {
    await expect(withOrgContext(orgA, (db) => customFields.setValues(db, orgA, 'widget', randomUUID(), { delivery_date: 'not-a-date' }), pool)).rejects.toThrow(/valid date/i);
  });

  it('TYPE VALIDATION: rejects an invalid email', async () => {
    await expect(withOrgContext(orgA, (db) => customFields.setValues(db, orgA, 'widget', randomUUID(), { contact_email: 'not-an-email' }), pool)).rejects.toThrow(/valid email/i);
  });

  it('TYPE VALIDATION: rejects an unknown field key', async () => {
    await expect(withOrgContext(orgA, (db) => customFields.setValues(db, orgA, 'widget', randomUUID(), { totally_unknown_field: 'x' }), pool)).rejects.toThrow(/unknown custom field/i);
  });

  it('ORGANISATION ISOLATION: field definitions from org A are invisible to org B', async () => {
    const defsB = await withOrgContext(orgB, (db) => customFields.getDefinitions(db, orgB, 'widget'), pool);
    expect(defsB).toHaveLength(0);

    // Setting a value in org B against org A's field key fails (org B has no such definition).
    await expect(withOrgContext(orgB, (db) => customFields.setValues(db, orgB, 'widget', randomUUID(), { warranty_status: 'active' }), pool)).rejects.toThrow(/unknown custom field/i);
  });

  it('ORGANISATION ISOLATION: values stored for an entity in org A are never returned when queried from org B context', async () => {
    const entityId = randomUUID();
    await withOrgContext(orgA, (db) => customFields.setValues(db, orgA, 'widget', entityId, { purchase_cost: 42 }), pool);

    const fromA = await withOrgContext(orgA, (db) => customFields.getValues(db, orgA, 'widget', entityId), pool);
    expect(fromA.purchase_cost).toBe(42);

    const fromB = await withOrgContext(orgB, (db) => customFields.getValues(db, orgB, 'widget', entityId), pool);
    expect(fromB).toEqual({}); // RLS: org B simply cannot see org A's row, even by guessing the entity id
  });

  it('required fields: refuses to write an explicit null over a required field', async () => {
    await withOrgContext(orgA, (db) => customFields.defineField(db, orgA, { appId: 'com.hexyrn.reference', entityType: 'gadget', key: 'serial_number', label: 'Serial', fieldType: 'short_text', isRequired: true }), pool);
    await expect(withOrgContext(orgA, (db) => customFields.setValues(db, orgA, 'gadget', randomUUID(), { serial_number: null }), pool)).rejects.toThrow(/required/i);
  });
});
