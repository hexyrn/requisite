import { promises as fs } from 'fs';
import { join, resolve } from 'path';

/**
 * Storage abstraction. Architecture-required, P1 item 13. Default is local
 * disk; the interface is deliberately narrow so a future S3-compatible
 * provider is a drop-in replacement - no caller outside this file ever
 * builds a filesystem path itself.
 */
export interface StorageProvider {
  write(key: string, data: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

export class LocalDiskStorageProvider implements StorageProvider {
  private readonly root: string;

  constructor(rootDir: string = process.env.LOCAL_STORAGE_PATH ?? './storage') {
    this.root = resolve(rootDir);
  }

  private resolveKeyPath(key: string): string {
    // `key` is always a server-generated random identifier (see
    // FileService.store) - never client input - but we still refuse
    // anything that isn't a plain, single-segment identifier, so even a
    // hypothetical future caller passing an attacker-influenced key cannot
    // traverse outside the storage root.
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw new Error('Invalid storage key.');
    }
    return join(this.root, key);
  }

  async write(key: string, data: Buffer): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(this.resolveKeyPath(key), data, { mode: 0o600 });
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolveKeyPath(key));
  }

  async delete(key: string): Promise<void> {
    await fs.rm(this.resolveKeyPath(key), { force: true });
  }
}
