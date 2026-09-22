import { Pool } from 'pg';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { ServiceAccountService } from '../service-account.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

describeIfDb('ServiceAccountService - API credentials and scopes (P2 items 11/12/13)', () => {
  let pool: Pool;
  let orgA: string;
  let orgB: string;
  const service = new ServiceAccountService();

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'API Org A');
    orgB = await createTestOrg(pool, 'API Org B');
  }, 60000);

  afterAll(async () => {
    await pool.end();
  });

  it('issues a credential and authenticates with the plaintext key, resolving the correct organisation and scopes', async () => {
    const account = await withOrgContext(orgA, (db) => service.createServiceAccount(db, orgA, 'Integration Bot', ['reference.widget.view']), pool);
    const issued = await withOrgContext(orgA, (db) => service.issueCredential(db, orgA, account.id, pool), pool);

    expect(issued.plaintextKey).toMatch(/^hxk_/);

    const auth = await service.authenticate(issued.plaintextKey, pool);
    expect(auth).not.toBeNull();
    expect(auth!.organisationId).toBe(orgA);
    expect(auth!.serviceAccountId).toBe(account.id);
    expect(auth!.scopes).toEqual(['reference.widget.view']);
  });

  it('SECRET SAFETY: only a hash is stored - the plaintext secret never appears in api_credentials', async () => {
    const account = await withOrgContext(orgA, (db) => service.createServiceAccount(db, orgA, 'Bot2', []), pool);
    const issued = await withOrgContext(orgA, (db) => service.issueCredential(db, orgA, account.id, pool), pool);
    const row = await withOrgContext(orgA, (db) => db.selectFrom('api_credentials').selectAll().where('id', '=', issued.credentialId).executeTakeFirstOrThrow(), pool);
    expect(row.secret_hash).not.toContain(issued.plaintextKey);
    expect(issued.plaintextKey).not.toContain(row.secret_hash);
  });

  it('rejects an unknown key prefix (fails closed, no cross-org enumeration)', async () => {
    const auth = await service.authenticate('hxk_doesnotexist.someSecretValue123456789', pool);
    expect(auth).toBeNull();
  });

  it('rejects a correct prefix with a wrong secret', async () => {
    const account = await withOrgContext(orgA, (db) => service.createServiceAccount(db, orgA, 'Bot3', []), pool);
    const issued = await withOrgContext(orgA, (db) => service.issueCredential(db, orgA, account.id, pool), pool);
    const [marker] = issued.plaintextKey.split('.');
    const auth = await service.authenticate(`${marker}.wrongsecretvaluexxxxxxxxxxxxxxxxxxxxxxxxxx`, pool);
    expect(auth).toBeNull();
  });

  it('REVOCATION: a revoked credential no longer authenticates', async () => {
    const account = await withOrgContext(orgA, (db) => service.createServiceAccount(db, orgA, 'Bot4', []), pool);
    const issued = await withOrgContext(orgA, (db) => service.issueCredential(db, orgA, account.id, pool), pool);
    await withOrgContext(orgA, (db) => service.revokeCredential(db, orgA, issued.credentialId, pool), pool);
    const auth = await service.authenticate(issued.plaintextKey, pool);
    expect(auth).toBeNull();
  });

  it('a disabled service account cannot authenticate even with a valid, non-revoked credential', async () => {
    const account = await withOrgContext(orgA, (db) => service.createServiceAccount(db, orgA, 'Bot5', []), pool);
    const issued = await withOrgContext(orgA, (db) => service.issueCredential(db, orgA, account.id, pool), pool);
    await withOrgContext(orgA, (db) => db.updateTable('service_accounts').set({ is_enabled: false }).where('id', '=', account.id).execute(), pool);
    const auth = await service.authenticate(issued.plaintextKey, pool);
    expect(auth).toBeNull();
  });

  it('ORGANISATION ISOLATION: a credential issued under org A resolves to org A even though org B also exists', async () => {
    const account = await withOrgContext(orgA, (db) => service.createServiceAccount(db, orgA, 'Bot6', []), pool);
    const issued = await withOrgContext(orgA, (db) => service.issueCredential(db, orgA, account.id, pool), pool);
    const auth = await service.authenticate(issued.plaintextKey, pool);
    expect(auth!.organisationId).toBe(orgA);
    expect(auth!.organisationId).not.toBe(orgB);
  });

  it('SCOPE GRANTING: cannot grant a scope the granter does not hold themselves', () => {
    const granterPermissions = new Set(['reference.widget.view']);
    expect(() => service.assertGrantableScopes(granterPermissions, ['reference.widget.view', 'reference.widget.delete'])).toThrow(/Cannot grant scope/i);
  });

  it('SCOPE GRANTING: allows granting scopes the granter holds', () => {
    const granterPermissions = new Set(['reference.widget.view', 'reference.widget.delete']);
    expect(() => service.assertGrantableScopes(granterPermissions, ['reference.widget.view'])).not.toThrow();
  });

  it('malformed keys are rejected before any database lookup', async () => {
    expect(await service.authenticate('not-a-valid-key', pool)).toBeNull();
    expect(await service.authenticate('hxk_noSeparator', pool)).toBeNull();
    expect(await service.authenticate('hxk_.emptyPrefix', pool)).toBeNull();
  });
});
