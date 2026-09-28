import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { DatasetService } from '../../reporting/dataset.service';
import { ReportQueryService } from '../../reporting/report-query.service';
import { ExportService } from '../export.service';
import { DataPortabilityService } from '../data-portability.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb(
  'DataPortabilityService - permission-safe full-organisation export (P2 item 22)',
  () => {
    let pool: Pool;
    let orgA: string;
    const datasets = new DatasetService();
    const queryEngine = new ReportQueryService();
    const exportsService = new ExportService(queryEngine, {} as any);
    const portability = new DataPortabilityService(exportsService);

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
      orgA = await createTestOrg(pool, 'Portability Org A');

      await datasets.registerDataset(
        {
          datasetKey: 'reference.widgets_portable',
          appId: 'com.hexyrn.reference',
          displayName: 'Widgets',
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
          datasetKey: 'reference.widgets_nonportable',
          appId: 'com.hexyrn.reference',
          displayName: 'Not Exportable',
          requiredPermission: 'reference.widget.view',
          sourceRef: 'reference_widgets',
          isExportable: false,
          fields: [{ key: 'id', label: 'ID', fieldType: 'string', isDimension: true }],
        } as any,
        pool,
      );
      await withOrgContext(
        orgA,
        (db) =>
          db
            .insertInto('reference_widgets')
            .values({ organisation_id: orgA, widget_number: 'DP-1', title: 'Portable Widget' })
            .execute(),
        pool,
      );
    }, 60000);

    afterAll(async () => {
      await pool.end();
    });

    it('bundles every exportable dataset the caller has permission for, as CSV', async () => {
      const bundle = await withOrgContext(
        orgA,
        (db) => portability.exportOrganisationData(db, subject(['reference.widget.view'], orgA)),
        pool,
      );
      expect(bundle['reference.widgets_portable']).toBeTruthy();
      expect(bundle['reference.widgets_portable'].rowCount).toBeGreaterThanOrEqual(1);
      expect(bundle['reference.widgets_portable'].csv.toString('utf8')).toContain(
        'Portable Widget',
      );
    });

    it('OMITS a non-exportable dataset from the bundle, without failing the whole export', async () => {
      const bundle = await withOrgContext(
        orgA,
        (db) => portability.exportOrganisationData(db, subject(['reference.widget.view'], orgA)),
        pool,
      );
      expect(bundle['reference.widgets_nonportable']).toBeUndefined();
    });

    it('PERMISSION SAFETY: omits a dataset the caller lacks permission for', async () => {
      const bundle = await withOrgContext(
        orgA,
        (db) => portability.exportOrganisationData(db, subject([], orgA)),
        pool,
      );
      expect(Object.keys(bundle)).toHaveLength(0);
    });
  },
);
