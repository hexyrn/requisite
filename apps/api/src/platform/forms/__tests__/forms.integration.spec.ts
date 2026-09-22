import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { FormService } from '../form.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('FormService - declarative validation, org-scoped customization (P1 item 6)', () => {
  let pool: Pool;
  let orgId: string;
  const forms = new FormService();

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgId = await createTestOrg(pool, 'Forms Test Org');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  const validDefinition = {
    sections: [
      {
        key: 'main',
        label: 'Main',
        fields: [{ key: 'title', label: 'Title', type: 'text' as const, required: true }],
      },
    ],
  };

  it('rejects a definition with an unsupported field key - no way to smuggle executable config in', async () => {
    const malicious = {
      sections: [
        {
          key: 'main',
          label: 'Main',
          fields: [{ key: 'title', label: 'Title', type: 'text', script: 'alert(1)' }],
        },
      ],
    };
    expect(() => forms.validateDefinitionShape(malicious)).toThrow(/unsupported keys/i);
  });

  it('rejects an invalid field type', async () => {
    const bad = {
      sections: [
        {
          key: 'main',
          label: 'Main',
          fields: [{ key: 'title', label: 'Title', type: 'not-a-real-type' }],
        },
      ],
    };
    expect(() => forms.validateDefinitionShape(bad)).toThrow(/invalid type/i);
  });

  it('seeds a default form and it can be retrieved', async () => {
    await withOrgContext(
      orgId,
      (db) =>
        forms.seedDefault(
          db,
          orgId,
          'com.hexyrn.reference',
          'widget.create',
          'Create Widget',
          validDefinition,
        ),
      pool,
    );
    const def = await withOrgContext(
      orgId,
      (db) => forms.getDefinition(db, orgId, 'com.hexyrn.reference', 'widget.create'),
      pool,
    );
    expect(def.is_customized).toBe(false);
    expect((def.definition as any).sections[0].fields[0].key).toBe('title');
  });

  it('an administrator can customize the seeded form', async () => {
    const customized = {
      sections: [
        {
          key: 'main',
          label: 'Main',
          fields: [
            { key: 'title', label: 'Widget Title', type: 'text' as const, required: true },
            { key: 'notes', label: 'Notes', type: 'textarea' as const },
          ],
        },
      ],
    };
    await withOrgContext(
      orgId,
      (db) => forms.customize(db, orgId, 'com.hexyrn.reference', 'widget.create', customized),
      pool,
    );
    const def = await withOrgContext(
      orgId,
      (db) => forms.getDefinition(db, orgId, 'com.hexyrn.reference', 'widget.create'),
      pool,
    );
    expect(def.is_customized).toBe(true);
    expect((def.definition as any).sections[0].fields).toHaveLength(2);
  });

  it('validateSubmission rejects a missing required field', () => {
    expect(() => forms.validateSubmission(validDefinition, {})).toThrow(/required/i);
  });

  it('validateSubmission accepts a complete submission', () => {
    expect(() => forms.validateSubmission(validDefinition, { title: 'My Widget' })).not.toThrow();
  });

  it('conditional fields are only required when their condition is met', () => {
    const conditionalDef = {
      sections: [
        {
          key: 'main',
          label: 'Main',
          fields: [
            { key: 'hasWarranty', label: 'Has warranty?', type: 'boolean' as const },
            {
              key: 'warrantyExpiry',
              label: 'Warranty expiry',
              type: 'date' as const,
              required: true,
              conditional: { dependsOn: 'hasWarranty', equals: true },
            },
          ],
        },
      ],
    };
    expect(() => forms.validateSubmission(conditionalDef, { hasWarranty: false })).not.toThrow();
    expect(() => forms.validateSubmission(conditionalDef, { hasWarranty: true })).toThrow(
      /required/i,
    );
    expect(() =>
      forms.validateSubmission(conditionalDef, { hasWarranty: true, warrantyExpiry: '2026-01-01' }),
    ).not.toThrow();
  });

  it('customizing a form that was never seeded fails', async () => {
    await expect(
      withOrgContext(
        orgId,
        (db) => forms.customize(db, orgId, 'com.hexyrn.reference', 'never-seeded', validDefinition),
        pool,
      ),
    ).rejects.toThrow(/not registered/i);
  });
});
