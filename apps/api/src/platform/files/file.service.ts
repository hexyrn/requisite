import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, Optional, PayloadTooLargeException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Kysely } from 'kysely';
import { Database } from '../../db/types';
import { StorageProvider, LocalDiskStorageProvider, STORAGE_PROVIDER } from './storage-provider';
import { mimeTypeMatchesContent } from './mime-sniff';

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/**
 * Secure shared file abstraction. Architecture-required, P1 item 13.
 * - `storage_key` is a random, server-generated identifier (never derived
 *   from the client-supplied filename) - see `generateStorageKey`.
 * - `original_filename` is stored purely as display metadata, never used
 *   to build a filesystem path (see LocalDiskStorageProvider).
 * - MIME type is validated against the actual file bytes, not trusted from
 *   the client's claimed Content-Type or the filename extension alone.
 * - Every read is organisation-scoped (RLS + an explicit ownership check),
 *   so a file id from one organisation can never be fetched by a caller
 *   authenticated into a different one (IDOR guard).
 */
@Injectable()
export class FileService {
  private readonly resolvedStorage: StorageProvider;

  constructor(@Optional() @Inject(STORAGE_PROVIDER) storage?: StorageProvider) {
    // Nest cannot resolve an interface-typed constructor parameter by
    // itself (interfaces don't exist at runtime, so its emitted metadata
    // type is just `Object`) - found empirically when FileService was
    // wired into PlatformModule ("Nest can't resolve dependencies of the
    // FileService"). Fixed with an explicit DI token (STORAGE_PROVIDER,
    // provided in PlatformModule) instead of relying on a plain
    // constructor default, which only works when the class is
    // instantiated directly with `new` (as the P1 file tests do) and not
    // when Nest's injector builds it.
    this.resolvedStorage = storage ?? new LocalDiskStorageProvider();
  }

  private generateStorageKey(): string {
    return randomBytes(32).toString('hex');
  }

  async store(
    db: Kysely<Database>,
    organisationId: string,
    buffer: Buffer,
    originalFilename: string,
    declaredMimeType: string,
    uploadedBy: string,
    entity?: { type: string; id: string },
  ): Promise<{ fileId: string }> {
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new PayloadTooLargeException(`File exceeds the maximum allowed size of ${MAX_FILE_SIZE_BYTES} bytes.`);
    }
    if (!ALLOWED_MIME_TYPES.has(declaredMimeType)) {
      throw new BadRequestException(`File type "${declaredMimeType}" is not allowed.`);
    }
    if (!mimeTypeMatchesContent(declaredMimeType, buffer)) {
      throw new BadRequestException('File content does not match its declared type.');
    }

    const storageKey = this.generateStorageKey();
    await this.resolvedStorage.write(storageKey, buffer);

    const row = await db
      .insertInto('files')
      .values({
        organisation_id: organisationId,
        storage_key: storageKey,
        original_filename: originalFilename,
        mime_type: declaredMimeType,
        size_bytes: String(buffer.length) as any,
        entity_type: entity?.type ?? null,
        entity_id: entity?.id ?? null,
        uploaded_by: uploadedBy,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { fileId: row.id };
  }

  /** Returns the file's bytes + metadata, or throws NotFound - RLS already confines this to the caller's organisation. */
  async retrieve(db: Kysely<Database>, organisationId: string, fileId: string): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    const row = await db.selectFrom('files').selectAll().where('id', '=', fileId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!row) throw new NotFoundException('File not found.');
    const buffer = await this.resolvedStorage.read(row.storage_key);
    return { buffer, filename: row.original_filename, mimeType: row.mime_type };
  }

  async delete(db: Kysely<Database>, organisationId: string, fileId: string, requestedBy: string): Promise<void> {
    const row = await db.selectFrom('files').selectAll().where('id', '=', fileId).where('organisation_id', '=', organisationId).executeTakeFirst();
    if (!row) throw new NotFoundException('File not found.');
    if (row.uploaded_by && row.uploaded_by !== requestedBy) {
      // P1 minimal policy: only the uploader may delete. A future
      // permission-based policy (e.g. an admin override) can extend this
      // without changing the method's shape.
      throw new ForbiddenException('Only the uploader may delete this file.');
    }
    await this.resolvedStorage.delete(row.storage_key);
    await db.deleteFrom('files').where('id', '=', fileId).execute();
  }
}
