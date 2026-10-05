import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Deliberately separate from Codex home, local SQLite, hooks and Personal Vault.
export const defaultRemoteDirectory = () => join(homedir(), '.config', 'org-brain', 'remote');
const fail = () => { throw new Error('remote_private_store_unavailable'); };

export class RemotePrivateStore {
  constructor({ directory = defaultRemoteDirectory(), profile = 'default' } = {}) {
    if (process.platform === 'win32') throw new Error('remote_private_store_platform_unsupported');
    if (!/^[a-zA-Z0-9_-]{1,64}$/u.test(profile)) throw new Error('remote_invalid_profile');
    this.directory = resolve(directory);
    const managed = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
    if (this.directory === managed || this.directory.startsWith(`${managed}/`) || this.directory.split('/').includes('.codex')) {
      throw new Error('remote_managed_credential_directory_forbidden');
    }
    this.path = join(this.directory, `${profile}.json`);
    this.lockPath = join(this.directory, `${profile}.lock`);
  }

  async inspectPath(path, { privateMode, missing = false } = {}) {
    const root = parse(path).root;
    let current = root;
    for (const part of path.slice(root.length).split('/').filter(Boolean)) {
      current = join(current, part);
      const stat = await lstat(current).catch(error => error.code === 'ENOENT' ? null : fail());
      if (!stat) { if (missing) return false; fail(); }
      if (stat.isSymbolicLink()) fail();
      if (current === path && privateMode !== undefined && process.platform !== 'win32') {
        if ((stat.mode & 0o777) !== privateMode || stat.uid !== process.getuid()) fail();
        // Reject FIFOs/devices before opening: O_RDONLY on a FIFO can block.
        if (privateMode === 0o700 ? !stat.isDirectory() : !stat.isFile()) fail();
      }
    }
    return true;
  }

  async prepare() {
    // Do not silently chmod a pre-existing shared directory or follow symlinks.
    await this.inspectPath(this.directory, { missing: true });
    await mkdir(this.directory, { recursive: true, mode: 0o700 }).catch(fail);
    await this.inspectPath(this.directory, { privateMode: 0o700 });
  }

  async read() {
    if (!await this.inspectPath(this.directory, { privateMode: 0o700, missing: true })) return null;
    if (!await this.inspectPath(this.path, { privateMode: 0o600, missing: true })) return null;
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(fail);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) fail();
      const buffer = Buffer.alloc(32 * 1024 + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > 32 * 1024) fail();
      return JSON.parse(buffer.subarray(0, total).toString('utf8'));
    } catch { fail(); } finally { await file.close(); }
  }

  async write(value) {
    await this.prepare();
    await this.inspectPath(this.path, { privateMode: 0o600, missing: true });
    const temporary = join(this.directory, `.pending-${randomUUID()}`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(fail);
    try {
      await file.writeFile(JSON.stringify(value) + '\n');
      await file.sync();
      await file.close();
      await rename(temporary, this.path);
      await this.syncDirectory();
    } catch { await file.close().catch(() => {}); fail(); }
    finally { await unlink(temporary).catch(() => {}); }
  }

  async clear() {
    await this.inspectPath(this.path, { privateMode: 0o600, missing: true });
    await unlink(this.path).catch(error => { if (error.code !== 'ENOENT') fail(); });
    await this.syncDirectory();
  }

  async syncDirectory() {
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(fail);
    try { await directory.sync(); } catch { fail(); } finally { await directory.close(); }
  }

  async withLock(callback) {
    await this.prepare();
    const lock = await open(this.lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      .catch(() => { throw new Error('remote_profile_locked'); });
    // Fail closed on an abandoned lock. Never expire/delete another process's lock.
    try { return await callback(); }
    finally { await lock.close(); await unlink(this.lockPath).catch(fail); }
  }
}
