import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AsyncQueue } from '../core/async-queue';
import { formatError, Logger } from '../core/logger';
import { basenameRemote } from '../core/remote-path';
import { BackupEntry, BackupIndex, BackupReason, BackupRetention } from './types';

/**
 * Backups live beside the source they protect, in the owning workspace folder:
 *
 *   <folder>/.rcc/backups/
 *   ├── index.json
 *   └── files/<sha1(remotePath).slice(0,12)>/
 *       └── 2026-07-03T14-05-22-311Z__wp-config.php
 *
 * The hashed folder per remote file keeps us clear of Windows MAX_PATH and
 * special characters in remote names. This module is vscode-free on purpose:
 * the caller resolves a profile id to its directory.
 */
export class BackupManager {
  private readonly queues = new Map<string, AsyncQueue>();

  constructor(
    private readonly resolveDir: (profileId: string) => string | undefined,
    private readonly logger: Logger,
    private readonly retention: () => BackupRetention
  ) {}

  private queue(profileId: string): AsyncQueue {
    let q = this.queues.get(profileId);
    if (!q) {
      q = new AsyncQueue();
      this.queues.set(profileId, q);
    }
    return q;
  }

  private profileDir(profileId: string): string {
    const dir = this.resolveDir(profileId);
    if (!dir) {
      // The folder owning this remote is no longer open, so there is nowhere
      // safe to put a backup — and a save must not proceed as if there were.
      throw new Error(`No backup location for remote ${profileId}: its workspace folder is not open.`);
    }
    return dir;
  }

  private indexPath(profileId: string): string {
    return path.join(this.profileDir(profileId), 'index.json');
  }

  private hashFor(remotePath: string): string {
    return crypto.createHash('sha1').update(remotePath, 'utf8').digest('hex').slice(0, 12);
  }

  fileDir(profileId: string, remotePath: string): string {
    return path.join(this.profileDir(profileId), 'files', this.hashFor(remotePath));
  }

  backupFilePath(entry: BackupEntry): string {
    return path.join(this.fileDir(entry.profileId, entry.remotePath), entry.fileName);
  }

  private async loadIndex(profileId: string): Promise<BackupIndex> {
    try {
      const raw = await fs.promises.readFile(this.indexPath(profileId), 'utf8');
      const parsed = JSON.parse(raw) as BackupIndex;
      return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
    } catch {
      return { entries: [] };
    }
  }

  private async saveIndex(profileId: string, index: BackupIndex): Promise<void> {
    const target = this.indexPath(profileId);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(index, null, 2), 'utf8');
    await fs.promises.rename(tmp, target);
  }

  async write(profileId: string, remotePath: string, data: Buffer, reason: BackupReason): Promise<BackupEntry> {
    return this.queue(profileId).run(async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const entry: BackupEntry = {
        id: `${Date.now()}-${crypto.randomBytes(2).toString('hex')}`,
        profileId,
        remotePath,
        fileName: `${stamp}__${basenameRemote(remotePath) || 'file'}`,
        timestamp: Date.now(),
        size: data.byteLength,
        reason
      };
      const dir = this.fileDir(profileId, remotePath);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, entry.fileName), data);

      const index = await this.loadIndex(profileId);
      index.entries.push(entry);
      await this.prune(index, profileId, remotePath);
      await this.saveIndex(profileId, index);
      this.logger.info(`[backup] ${reason} ${remotePath} (${data.byteLength} bytes)`);
      return entry;
    });
  }

  /** Prune this file's backups by count and every entry by age. Mutates the index. */
  private async prune(index: BackupIndex, profileId: string, remotePath: string): Promise<void> {
    const { maxPerFile, maxAgeDays } = this.retention();
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    const drop = new Set<string>();

    const forFile = index.entries
      .filter((e) => e.remotePath === remotePath)
      .sort((a, b) => b.timestamp - a.timestamp);
    for (const excess of forFile.slice(Math.max(1, maxPerFile))) {
      drop.add(excess.id);
    }
    for (const entry of index.entries) {
      if (entry.timestamp < cutoff) {
        drop.add(entry.id);
      }
    }
    if (drop.size === 0) {
      return;
    }
    for (const entry of index.entries.filter((e) => drop.has(e.id))) {
      try {
        await fs.promises.unlink(this.backupFilePath(entry));
      } catch (err) {
        this.logger.debug(`[backup] prune unlink failed: ${formatError(err)}`);
      }
    }
    index.entries = index.entries.filter((e) => !drop.has(e.id));
  }

  async listAll(profileId: string): Promise<BackupEntry[]> {
    const index = await this.loadIndex(profileId);
    return index.entries.sort((a, b) => b.timestamp - a.timestamp);
  }

  async listForFile(profileId: string, remotePath: string): Promise<BackupEntry[]> {
    return (await this.listAll(profileId)).filter((e) => e.remotePath === remotePath);
  }

  async latestFor(profileId: string, remotePath: string): Promise<BackupEntry | undefined> {
    return (await this.listForFile(profileId, remotePath))[0];
  }

  async read(entry: BackupEntry): Promise<Buffer> {
    return fs.promises.readFile(this.backupFilePath(entry));
  }

  async deleteEntry(entry: BackupEntry): Promise<void> {
    await this.queue(entry.profileId).run(async () => {
      try {
        await fs.promises.unlink(this.backupFilePath(entry));
      } catch {
        // already gone
      }
      const index = await this.loadIndex(entry.profileId);
      index.entries = index.entries.filter((e) => e.id !== entry.id);
      await this.saveIndex(entry.profileId, index);
    });
  }
}
