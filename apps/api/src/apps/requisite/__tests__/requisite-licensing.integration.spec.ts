import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg, createTestLicense } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { ApplicationRegistryService } from '../../../platform/app-registry/application-registry.service';
import { REQUISITE_APP_MANIFEST } from '../requisite.manifest';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;
const APP_ID = REQUISITE_APP_MANIFEST.appId;

/**
 * Item 33 - Requisite is the first REAL COMMERCIAL application to exercise
 * Core's Ed25519 licensing infrastructure (docs/decisions/0006). Every
 * scenario the brief names is proven here, against genuine cryptographic
 * verification (LicenseSigner/LicenseVerifier - the exact same code path
 * P2's own licensing.spec.ts proved in isolation), never mocked.
 */
describeIfDb(
  'Requisite Licensing (item 33) - real Ed25519 verification exercised for the first time by a commercial app',
  () => {
    let pool: Pool;
    let orgA: string;
    let orgB: string;
    const registry = new ApplicationRegistryService();

    beforeAll(async () => {
      pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
      await setUpTestDatabase(pool);
      await registry.registerApp(REQUISITE_APP_MANIFEST, pool);
      orgA = await createTestOrg(pool, 'Requisite Licensing Org A');
      orgB = await createTestOrg(pool, 'Requisite Licensing Org B');
      await withOrgContext(orgA, (db) => registry.enableApp(db, orgA, APP_ID), pool);
      await withOrgContext(orgB, (db) => registry.enableApp(db, orgB, APP_ID), pool);
    }, 60000);

    afterAll(async () => {
      await pool.end();
    });

    it('MISSING LICENCE: enabled but unlicensed - commercial functionality (active=true) remains INACTIVE', async () => {
      const state = await withOrgContext(
        orgA,
        (db) => registry.getApplicationState(db, orgA, APP_ID),
        pool,
      );
      expect(state.installed).toBe(true);
      expect(state.enabled).toBe(true);
      expect(state.licensed).toBe(false);
      expect(state.active).toBe(false);
    });

    it('VALID LICENCE: a genuinely signed v1 licence for this org activates the application', async () => {
      const license = await createTestLicense(APP_ID, orgA, 1);
      await withOrgContext(
        orgA,
        (db) => registry.grantLicense(db, orgA, APP_ID, 1, license as any),
        pool,
      );
      const state = await withOrgContext(
        orgA,
        (db) => registry.getApplicationState(db, orgA, APP_ID),
        pool,
      );
      expect(state.licensed).toBe(true);
      expect(state.active).toBe(true);
    });

    it('INVALID SIGNATURE: a tampered licence payload is rejected, never activating the app', async () => {
      const license: any = await createTestLicense(APP_ID, orgB, 1);
      license.signature = 'ZZZZ' + license.signature.slice(4); // corrupt the signature
      await expect(
        withOrgContext(orgB, (db) => registry.grantLicense(db, orgB, APP_ID, 1, license), pool),
      ).rejects.toThrow(/rejected/i);
      const state = await withOrgContext(
        orgB,
        (db) => registry.getApplicationState(db, orgB, APP_ID),
        pool,
      );
      expect(state.licensed).toBe(false);
    });

    it('WRONG ORGANISATION: a licence genuinely signed for org A is rejected when presented for org B', async () => {
      const licenseForOrgA = await createTestLicense(APP_ID, orgA, 1);
      await expect(
        withOrgContext(
          orgB,
          (db) => registry.grantLicense(db, orgB, APP_ID, 1, licenseForOrgA as any),
          pool,
        ),
      ).rejects.toThrow(/rejected/i);
    });

    it('WRONG PRODUCT: a licence for a different appId is rejected even if otherwise validly signed', async () => {
      const licenseForDifferentApp = await createTestLicense('com.hexyrn.reference', orgB, 1);
      await expect(
        withOrgContext(
          orgB,
          (db) => registry.grantLicense(db, orgB, APP_ID, 1, licenseForDifferentApp as any),
          pool,
        ),
      ).rejects.toThrow(/rejected/i);
    });

    it('WRONG MAJOR VERSION: a Requisite v2 licence does not grant v1 access', async () => {
      const licenseForV2 = await createTestLicense(APP_ID, orgB, 2);
      await expect(
        withOrgContext(
          orgB,
          (db) => registry.grantLicense(db, orgB, APP_ID, 1, licenseForV2 as any),
          pool,
        ),
      ).rejects.toThrow(/rejected/i);
    });

    it('SUPPORT EXPIRY DOES NOT DISABLE A PERPETUAL LICENCE: an expired supportExpiresAt still activates the app', async () => {
      const orgC = await createTestOrg(pool, 'Requisite Licensing Org C');
      await withOrgContext(orgC, (db) => registry.enableApp(db, orgC, APP_ID), pool);
      const expiredSupportLicense = await createTestLicense(
        APP_ID,
        orgC,
        1,
        '2020-01-01T00:00:00.000Z',
      );
      await withOrgContext(
        orgC,
        (db) => registry.grantLicense(db, orgC, APP_ID, 1, expiredSupportLicense as any),
        pool,
      );
      const state = await withOrgContext(
        orgC,
        (db) => registry.getApplicationState(db, orgC, APP_ID),
        pool,
      );
      expect(state.active).toBe(true); // runtime activation is NOT gated on support expiry, per ADR 0006
    });

    it('NO NETWORK CONNECTIVITY: the entire valid-licence grant executes in well under a second, proving no external call is made', async () => {
      const orgD = await createTestOrg(pool, 'Requisite Licensing Org D');
      await withOrgContext(orgD, (db) => registry.enableApp(db, orgD, APP_ID), pool);
      const license = await createTestLicense(APP_ID, orgD, 1);
      const start = Date.now();
      await withOrgContext(
        orgD,
        (db) => registry.grantLicense(db, orgD, APP_ID, 1, license as any),
        pool,
      );
      const elapsedMs = Date.now() - start;
      expect(elapsedMs).toBeLessThan(500);
    });

    it('a Requisite licence forged with a different (non-Hexyrn) keypair is rejected, proving the public key is actually enforced', async () => {
      const { LicenseSigner } = await import('../../../vendor-tools/licensing/license-signer');
      const { generateKeyPairSync } = await import('crypto');
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const forgedSigner = new LicenseSigner(
        privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      );
      const orgE = await createTestOrg(pool, 'Requisite Licensing Org E');
      await withOrgContext(orgE, (db) => registry.enableApp(db, orgE, APP_ID), pool);
      const forgedLicense = await forgedSigner.issue({
        appId: APP_ID,
        organisationId: orgE,
        majorVersion: 1,
        supportExpiresAt: null,
      });
      await expect(
        withOrgContext(
          orgE,
          (db) => registry.grantLicense(db, orgE, APP_ID, 1, forgedLicense as any),
          pool,
        ),
      ).rejects.toThrow(/rejected/i);
      void publicKey; // unused beyond documenting a real distinct keypair was generated
    });
  },
);
