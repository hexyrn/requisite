import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { DatasetService } from '../../reporting/dataset.service';
import { ReportQueryService } from '../../reporting/report-query.service';
import { ExportService } from '../export.service';
import { sanitizeForSpreadsheet, toCsv } from '../csv-safe';
import { FileService } from '../../files/file.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describe('csv-safe: formula-injection defense (P2 item 24)', () => {
  it('prefixes values starting with =, +, -, @, tab, or CR with a single quote', () => {
    expect(sanitizeForSpreadsheet('=cmd|"/c calc"!A1')).toBe('\'=cmd|"/c calc"!A1');
    expect(sanitizeForSpreadsheet('+1+1')).toBe("'+1+1");
    expect(sanitizeForSpreadsheet('-1')).toBe("'-1");
    expect(sanitizeForSpreadsheet('@SUM(1)')).toBe("'@SUM(1)");
    expect(sanitizeForSpreadsheet('\tevil')).toBe("'\tevil");
  });

  it('leaves ordinary values untouched', () => {
    expect(sanitizeForSpreadsheet('Widget A')).toBe('Widget A');
    expect(sanitizeForSpreadsheet(42)).toBe('42');
    expect(sanitizeForSpreadsheet(null)).toBe('');
  });

  it('toCsv output is quote-prefixed for a malicious formula cell and still valid CSV', () => {
    const csv = toCsv([{ name: '=cmd|"/c calc"!A1', value: 5 }], ['name', 'value']);
    expect(csv).toContain('"\'=cmd');
  });
});

describeIfDb(
  'ExportService - export framework over the permission-aware query path (P2 item 7)',
  () => {
    let pool: Pool;
    let orgA: string;
    const datasets = new DatasetService();
    const queryEngine = new ReportQueryService();
    const exportsService = new ExportService(queryEngine, {} as FileService);

    function subject(permissions: string[], organisationId: string) {
      return {
        userAccountId: randomUUID(),
        organisationId,
        grantedPermissions: new Set(permissions),
      };
    }

    beforeAll(async () => {
      pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
      await setUpTestDatabase(pool);
      orgA = await createTestOrg(pool, 'Export Org A');

      await datasets.registerDataset(
        {
          datasetKey: 'reference.widgets_export',
          appId: 'com.hexyrn.reference',
          displayName: 'Widgets Export',
          requiredPermission: 'reference.widget.view',
          sourceRef: 'reference_widgets',
          isExportable: true,
          fields: [
            { key: 'id', label: 'ID', fieldType: 'string', isDimension: true },
            { key: 'title', label: 'Title', fieldType: 'string', isDimension: true },
          ],
        } as any,
        pool,
      );
      await datasets.registerDataset(
        {
          datasetKey: 'reference.widgets_notexportable',
          appId: 'com.hexyrn.reference',
          displayName: 'Widgets Non-Exportable',
          requiredPermission: 'reference.widget.view',
          sourceRef: 'reference_widgets',
          isExportable: false,
          fields: [{ key: 'id', label: 'ID', fieldType: 'string', isDimension: true }],
        } as any,
        pool,
      );
    }, 60000);

    afterAll(async () => {
      await pool.end();
    });

    it('exports CSV bytes for rows fetched through ReportQueryService', async () => {
      await withOrgContext(
        orgA,
        (db) =>
          db
            .insertInto('reference_widgets')
            .values({ organisation_id: orgA, widget_number: 'EW-1', title: '=cmd|"/c calc"!A1' })
            .execute(),
        pool,
      );
      const buffer = await withOrgContext(
        orgA,
        async (db) => {
          const { rows } = await exportsService.runQueryForExport(
            db,
            subject(['reference.widget.view'], orgA),
            { datasetKey: 'reference.widgets_export', fields: ['id', 'title'] },
          );
          return exportsService.toCsvBuffer(rows, ['id', 'title']);
        },
        pool,
      );
      const csv = buffer.toString('utf8');
      expect(csv).toContain("'=cmd");
    });

    it('exports XLSX bytes without throwing and produces a non-trivial buffer', async () => {
      const buffer = await withOrgContext(
        orgA,
        async (db) => {
          const { rows } = await exportsService.runQueryForExport(
            db,
            subject(['reference.widget.view'], orgA),
            { datasetKey: 'reference.widgets_export', fields: ['id', 'title'] },
          );
          return exportsService.toXlsxBuffer(rows, ['id', 'title']);
        },
        pool,
      );
      expect(buffer.length).toBeGreaterThan(100);
    });

    it('exports PDF bytes with org branding without throwing', async () => {
      const buffer = await withOrgContext(
        orgA,
        async (db) => {
          const { rows } = await exportsService.runQueryForExport(
            db,
            subject(['reference.widget.view'], orgA),
            { datasetKey: 'reference.widgets_export', fields: ['id', 'title'] },
          );
          return exportsService.toPdfBuffer(rows, ['id', 'title'], {
            organisationName: 'Export Org A',
            reportTitle: 'Widgets Report',
          });
        },
        pool,
      );
      expect(buffer.subarray(0, 4).toString('utf8')).toBe('%PDF');
    });

    it('EXPORT PERMISSIONS: a subject without the dataset permission cannot export its data', async () => {
      await expect(
        withOrgContext(
          orgA,
          (db) =>
            exportsService.runQueryForExport(db, subject([], orgA), {
              datasetKey: 'reference.widgets_export',
              fields: ['id'],
            }),
          pool,
        ),
      ).rejects.toThrow(/missing required permission/i);
    });

    it('EXPORTABILITY: a dataset marked is_exportable=false cannot be exported even with permission', async () => {
      await expect(
        withOrgContext(
          orgA,
          (db) =>
            exportsService.runQueryForExport(db, subject(['reference.widget.view'], orgA), {
              datasetKey: 'reference.widgets_notexportable',
              fields: ['id'],
            }),
          pool,
        ),
      ).rejects.toThrow(/not exportable/i);
    });

    it('records an export job as an audit trail entry (P2 item 23)', async () => {
      const jobId = await withOrgContext(
        orgA,
        (db) =>
          exportsService.recordExportJob(
            db,
            orgA,
            'reference.widgets_export',
            'csv',
            1,
            'local:test-file-ref',
          ),
        pool,
      );
      expect(jobId).toBeTruthy();
      const job = await withOrgContext(
        orgA,
        (db) =>
          db
            .selectFrom('export_jobs')
            .selectAll()
            .where('id', '=', jobId)
            .executeTakeFirstOrThrow(),
        pool,
      );
      expect(job.status).toBe('completed');
      expect(job.dataset_key).toBe('reference.widgets_export');
    });
  },
);
