import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { ImportService } from '../import.service';
import { ImportHandlerRegistryService } from '../import-row-handler';
import { parseCsv, MAX_IMPORT_ROWS, CsvTooLargeError } from '../csv-parse';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describe('parseCsv - bounded CSV parsing (P2 items 10/24)', () => {
  it('parses headers and rows, handling quoted commas', () => {
    const { headers, rows } = parseCsv('title,notes\n"Widget, Deluxe",Fine\nSimple,Ok');
    expect(headers).toEqual(['title', 'notes']);
    expect(rows).toEqual([
      { title: 'Widget, Deluxe', notes: 'Fine' },
      { title: 'Simple', notes: 'Ok' },
    ]);
  });

  it('rejects a CSV with more than MAX_IMPORT_ROWS data rows', () => {
    const header = 'a\n';
    const body = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => '1').join('\n');
    expect(() => parseCsv(header + body)).toThrow(CsvTooLargeError);
  });

  it('truncates an individual cell that exceeds MAX_CELL_LENGTH', () => {
    const hugeCell = 'x'.repeat(20_000);
    const { rows } = parseCsv(`a\n${hugeCell}`);
    expect(rows[0].a.length).toBeLessThanOrEqual(10_000);
  });
});

describeIfDb(
  'ImportService - permission-safe import over an app-registered handler (P2 item 10)',
  () => {
    let pool: Pool;
    let orgA: string;
    const handlers = new ImportHandlerRegistryService();
    const importService = new ImportService(handlers);
    const imported: Record<string, unknown>[] = [];

    let testUserId: string;

    function subject(permissions: string[], organisationId: string) {
      return {
        userAccountId: testUserId,
        organisationId,
        grantedPermissions: new Set(permissions),
      };
    }

    beforeAll(async () => {
      pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
      await setUpTestDatabase(pool);
      orgA = await createTestOrg(pool, 'Import Org A');
      testUserId = await withOrgContext(
        orgA,
        (db) =>
          db
            .insertInto('user_accounts')
            .values({
              organisation_id: orgA,
              email: `import-${randomUUID()}@example.com`,
              password_hash: 'x',
              is_active: true,
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        pool,
      ).then((r) => r.id);

      await withOrgContext(
        orgA,
        (db) =>
          importService.registerEntityType(
            db,
            'reference.widget.import',
            'com.hexyrn.reference',
            'reference.widget.create',
            [
              { key: 'title', label: 'Title', required: true, fieldType: 'string' },
              { key: 'count', label: 'Count', fieldType: 'number' },
            ],
          ),
        pool,
      );

      handlers.register('reference.widget.import', async (_db, _orgId, row) => {
        if (row.title === 'FAIL_ME') throw new Error('simulated row failure');
        imported.push(row);
      });
    }, 60000);

    afterAll(async () => {
      await pool.end();
    });

    it('imports rows through the registered handler, mapping only declared fields', async () => {
      const rows = [{ Name: 'Widget A', Qty: '5', UndeclaredColumn: 'should not pass through' }];
      const result = await withOrgContext(
        orgA,
        (db) =>
          importService.runImport(
            db,
            subject(['reference.widget.create'], orgA),
            'reference.widget.import',
            rows,
            { title: 'Name', count: 'Qty' },
          ),
        pool,
      );
      expect(result.successCount).toBe(1);
      expect(result.errorCount).toBe(0);
      expect(imported[imported.length - 1]).toEqual({ title: 'Widget A', count: 5 });
    });

    it('PERMISSION SAFETY: a subject without the required permission cannot import', async () => {
      await expect(
        withOrgContext(
          orgA,
          (db) =>
            importService.runImport(
              db,
              subject([], orgA),
              'reference.widget.import',
              [{ Name: 'X' }],
              { title: 'Name' },
            ),
          pool,
        ),
      ).rejects.toThrow(/missing required permission/i);
    });

    it('a row failing the handler is recorded as an error without discarding other successful rows', async () => {
      const rows = [{ Name: 'Good Row' }, { Name: 'FAIL_ME' }, { Name: 'Another Good Row' }];
      const result = await withOrgContext(
        orgA,
        (db) =>
          importService.runImport(
            db,
            subject(['reference.widget.create'], orgA),
            'reference.widget.import',
            rows,
            { title: 'Name' },
          ),
        pool,
      );
      expect(result.successCount).toBe(2);
      expect(result.errorCount).toBe(1);

      const job = await withOrgContext(
        orgA,
        (db) =>
          db
            .selectFrom('import_jobs')
            .selectAll()
            .where('id', '=', result.jobId)
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(job.status).toBe('completed_with_errors');
      expect((job.row_errors as any[]).length).toBe(1);
    });

    it('a missing required field is recorded as a row error, not thrown', async () => {
      const rows = [{ Name: '' }];
      const result = await withOrgContext(
        orgA,
        (db) =>
          importService.runImport(
            db,
            subject(['reference.widget.create'], orgA),
            'reference.widget.import',
            rows,
            { title: 'Name' },
          ),
        pool,
      );
      expect(result.errorCount).toBe(1);
      expect(result.successCount).toBe(0);
    });

    it('rejects an unregistered entity type', async () => {
      await expect(
        withOrgContext(
          orgA,
          (db) =>
            importService.runImport(db, subject(['anything'], orgA), 'not.registered', [], {}),
          pool,
        ),
      ).rejects.toThrow(/not registered/i);
    });
  },
);
