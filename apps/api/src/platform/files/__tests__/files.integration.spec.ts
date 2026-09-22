import { Pool } from 'pg';
import { rmSync } from 'fs';
import { join } from 'path';
import { setUpTestDatabase, createTestOrg } from '../../../test-utils/test-db';
import { withOrgContext } from '../../../db/org-context';
import { attachPoolErrorHandler } from '../../../db/pool';
import { FileService } from '../file.service';
import { LocalDiskStorageProvider } from '../storage-provider';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

const TEST_STORAGE_ROOT = join(__dirname, '.test-storage');

// Real PNG signature bytes so MIME-sniffing accepts it.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describeIfDb('FileService - access control, cross-org IDOR (P1 item 13)', () => {
  let pool: Pool;
  let orgA: string;
  let orgB: string;
  let uploaderA: string;
  const files = new FileService(new LocalDiskStorageProvider(TEST_STORAGE_ROOT));

  beforeAll(async () => {
    pool = attachPoolErrorHandler(new Pool({ connectionString: TEST_DATABASE_URL, max: 10 }));
    await setUpTestDatabase(pool);
    orgA = await createTestOrg(pool, 'Files Org A');
    orgB = await createTestOrg(pool, 'Files Org B');
    const user = await withOrgContext(
      orgA,
      (db) =>
        db
          .insertInto('user_accounts')
          .values({
            organisation_id: orgA,
            email: 'uploader@files.test',
            password_hash: 'x',
            is_active: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      pool,
    );
    uploaderA = user.id;
  }, 60000);

  afterAll(async () => {
    await pool.end();
    rmSync(TEST_STORAGE_ROOT, { recursive: true, force: true });
  });

  it('stores a file with a random storage key, never derived from the original filename', async () => {
    const { fileId } = await withOrgContext(
      orgA,
      (db) => files.store(db, orgA, PNG_BYTES, '../../../etc/passwd.png', 'image/png', uploaderA),
      pool,
    );
    const row = await withOrgContext(
      orgA,
      (db) => db.selectFrom('files').selectAll().where('id', '=', fileId).executeTakeFirstOrThrow(),
      pool,
    );
    expect(row.storage_key).not.toContain('passwd');
    expect(row.storage_key).not.toContain('.');
    expect(row.storage_key).not.toContain('/');
    expect(row.original_filename).toBe('../../../etc/passwd.png'); // preserved as DISPLAY metadata only
  });

  it('retrieves a stored file by id, returning the original bytes', async () => {
    const { fileId } = await withOrgContext(
      orgA,
      (db) => files.store(db, orgA, PNG_BYTES, 'photo.png', 'image/png', uploaderA),
      pool,
    );
    const result = await withOrgContext(orgA, (db) => files.retrieve(db, orgA, fileId), pool);
    expect(result.buffer.equals(PNG_BYTES)).toBe(true);
    expect(result.filename).toBe('photo.png');
  });

  it('rejects an upload whose declared MIME type does not match its actual content (magic-byte sniffing)', async () => {
    const fakeBytes = Buffer.from('this is not actually a PNG file');
    await expect(
      withOrgContext(
        orgA,
        (db) => files.store(db, orgA, fakeBytes, 'fake.png', 'image/png', uploaderA),
        pool,
      ),
    ).rejects.toThrow(/does not match/i);
  });

  it('rejects a disallowed MIME type outright', async () => {
    await expect(
      withOrgContext(
        orgA,
        (db) =>
          files.store(
            db,
            orgA,
            Buffer.from('#!/bin/sh\necho hi'),
            'script.sh',
            'application/x-sh',
            uploaderA,
          ),
        pool,
      ),
    ).rejects.toThrow(/not allowed/i);
  });

  it('rejects a file exceeding the size limit', async () => {
    const huge = Buffer.alloc(26 * 1024 * 1024, 0x89); // 26MB, over the 25MB limit
    await expect(
      withOrgContext(
        orgA,
        (db) => files.store(db, orgA, huge, 'huge.png', 'image/png', uploaderA),
        pool,
      ),
    ).rejects.toThrow(/exceeds the maximum/i);
  });

  it('CROSS-ORGANISATION FILE ACCESS: a file uploaded in org A cannot be retrieved from org B context, even with the correct file id (IDOR)', async () => {
    const { fileId } = await withOrgContext(
      orgA,
      (db) => files.store(db, orgA, PNG_BYTES, 'secret.png', 'image/png', uploaderA),
      pool,
    );
    await expect(
      withOrgContext(orgB, (db) => files.retrieve(db, orgB, fileId), pool),
    ).rejects.toThrow(/not found/i);
  });

  it('only the uploader may delete their file (not an arbitrary other user in the same org)', async () => {
    const { fileId } = await withOrgContext(
      orgA,
      (db) => files.store(db, orgA, PNG_BYTES, 'mine.png', 'image/png', uploaderA),
      pool,
    );
    const otherUser = await withOrgContext(
      orgA,
      (db) =>
        db
          .insertInto('user_accounts')
          .values({
            organisation_id: orgA,
            email: 'other@files.test',
            password_hash: 'x',
            is_active: true,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
      pool,
    );

    await expect(
      withOrgContext(orgA, (db) => files.delete(db, orgA, fileId, otherUser.id), pool),
    ).rejects.toThrow(/only the uploader/i);

    // The uploader themselves can delete it.
    await withOrgContext(orgA, (db) => files.delete(db, orgA, fileId, uploaderA), pool);
    await expect(
      withOrgContext(orgA, (db) => files.retrieve(db, orgA, fileId), pool),
    ).rejects.toThrow(/not found/i);
  });

  it('storage keys are path-traversal safe even if a key were ever attacker-influenced', async () => {
    const provider = new LocalDiskStorageProvider(TEST_STORAGE_ROOT);
    await expect(provider.read('../../../etc/passwd')).rejects.toThrow(/invalid storage key/i);
    await expect(provider.write('../evil', Buffer.from('x'))).rejects.toThrow(
      /invalid storage key/i,
    );
  });
});
