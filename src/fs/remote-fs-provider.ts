import * as vscode from 'vscode';
import { BackupManager } from '../backup/backup-manager';
import { config } from '../config';
import { ConnectionManager, ManagedConnection } from '../connection/connection-manager';
import { RemoteFileEntry } from '../connection/types';
import { RccError } from '../core/errors';
import { formatError, Logger } from '../core/logger';
import { basenameRemote, dirnameRemote, parseRccParts } from './uri';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { ServerProfile } from '../profiles/types';
import { SavePipeline } from '../save/save-pipeline';
import { FileStateTracker } from './file-state-tracker';

export interface RemoteFsDeps {
  profiles: RemoteConfigStore;
  manager: ConnectionManager;
  tracker: FileStateTracker;
  pipeline: SavePipeline;
  backups: BackupManager;
  logger: Logger;
}

interface UriContext {
  profile: ServerProfile;
  conn: ManagedConnection;
  remotePath: string;
}

/**
 * The single FileSystemProvider both UX modes share. The tree opens files
 * through rcc: URIs, and "Mount as Workspace Folder" mounts the same scheme,
 * so every write funnels into the SavePipeline exactly once.
 */
export class RemoteFsProvider implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(private readonly deps: RemoteFsDeps) {}

  private ctx(uri: vscode.Uri): UriContext {
    let parsed: { profileId: string; remotePath: string };
    try {
      parsed = parseRccParts(uri);
    } catch (err) {
      throw vscode.FileSystemError.FileNotFound(String(err));
    }
    const profile = this.deps.profiles.get(parsed.profileId);
    if (!profile) {
      throw vscode.FileSystemError.FileNotFound(`No server profile for ${uri.toString()}`);
    }
    return { profile, conn: this.deps.manager.getConnection(profile.id), remotePath: parsed.remotePath };
  }

  private toFsError(err: unknown, uri: vscode.Uri): Error {
    if (err instanceof vscode.FileSystemError) {
      return err;
    }
    if (err instanceof RccError) {
      switch (err.code) {
        case 'FileNotFound':
          return vscode.FileSystemError.FileNotFound(uri);
        case 'NoPermissions':
          return vscode.FileSystemError.NoPermissions(err.message);
        case 'FileExists':
          return vscode.FileSystemError.FileExists(uri);
        default:
          return vscode.FileSystemError.Unavailable(err.message);
      }
    }
    const message = formatError(err).toLowerCase();
    if (message.includes('no such file') || message.startsWith('550')) {
      return vscode.FileSystemError.FileNotFound(uri);
    }
    if (message.includes('permission denied') || message.startsWith('553') || message.startsWith('530')) {
      return vscode.FileSystemError.NoPermissions(formatError(err));
    }
    return vscode.FileSystemError.Unavailable(formatError(err));
  }

  private assertWritable(profile: ServerProfile): void {
    if (profile.readOnly) {
      throw vscode.FileSystemError.NoPermissions(
        `"${profile.name}" is a read-only profile. Enable writing in the profile settings first.`
      );
    }
  }

  private toFileType(entry: RemoteFileEntry): vscode.FileType {
    switch (entry.type) {
      case 'directory':
        return vscode.FileType.Directory;
      case 'symlink':
        // FTP cannot tell what a symlink points at; assume directory (the common
        // shared-hosting case, e.g. www -> public_html) so it stays browsable.
        return vscode.FileType.SymbolicLink | vscode.FileType.Directory;
      default:
        return vscode.FileType.File;
    }
  }

  watch(): vscode.Disposable {
    // No remote change notifications — we only fire events for our own mutations.
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { profile, conn, remotePath } = this.ctx(uri);
    try {
      const entry = await conn.stat(remotePath);
      return {
        type: this.toFileType(entry),
        ctime: 0,
        mtime: entry.mtimeMs ?? 0,
        size: entry.size,
        permissions: profile.readOnly ? vscode.FilePermission.Readonly : undefined
      };
    } catch (err) {
      throw this.toFsError(err, uri);
    }
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { conn, remotePath } = this.ctx(uri);
    try {
      const entries = await conn.list(remotePath);
      return entries.map((e) => [e.name, this.toFileType(e)]);
    } catch (err) {
      throw this.toFsError(err, uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { conn, remotePath } = this.ctx(uri);
    try {
      const entry = await conn.stat(remotePath);
      const limit = config.maxFileSizeBytes();
      if (entry.size > limit) {
        throw vscode.FileSystemError.Unavailable(
          `${basenameRemote(remotePath)} is ${(entry.size / 1024 / 1024).toFixed(1)} MB — larger than the ${Math.round(
            limit / 1024 / 1024
          )} MB open limit. Use "Download..." instead, or raise remoteCodeCompanion.maxFileSizeMB.`
        );
      }
      const bytes = await conn.readFile(remotePath);
      // Baseline for conflict detection: what the server said just before we read.
      this.deps.tracker.capture(uri.toString(), entry);
      return bytes;
    } catch (err) {
      throw this.toFsError(err, uri);
    }
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): Promise<void> {
    const { profile, conn, remotePath } = this.ctx(uri);
    this.assertWritable(profile);
    try {
      if (!options.create || !options.overwrite) {
        const exists = await this.exists(conn, remotePath);
        if (!options.create && !exists) {
          throw vscode.FileSystemError.FileNotFound(uri);
        }
        if (!options.overwrite && exists) {
          throw vscode.FileSystemError.FileExists(uri);
        }
      }
      const { created } = await this.deps.pipeline.run(profile, conn, uri, remotePath, content);
      this.emitter.fire([{ type: created ? vscode.FileChangeType.Created : vscode.FileChangeType.Changed, uri }]);
    } catch (err) {
      throw this.toFsError(err, uri);
    }
  }

  private async exists(conn: ManagedConnection, remotePath: string): Promise<boolean> {
    try {
      await conn.stat(remotePath);
      return true;
    } catch (err) {
      if (err instanceof RccError && err.code === 'FileNotFound') {
        return false;
      }
      const message = formatError(err).toLowerCase();
      if (message.includes('no such file') || message.startsWith('550')) {
        return false;
      }
      throw err;
    }
  }

  async delete(uri: vscode.Uri, _options: { recursive: boolean }): Promise<void> {
    const { profile, conn, remotePath } = this.ctx(uri);
    this.assertWritable(profile);
    try {
      const entry = await conn.stat(remotePath);
      const backupEnabled = profile.backupOnSave ?? config.backupEnabled();
      if (entry.type === 'file' && backupEnabled) {
        try {
          const bytes = await conn.readFile(remotePath);
          await this.deps.backups.write(profile.id, remotePath, bytes, 'pre-delete');
        } catch (err) {
          const answer = await vscode.window.showWarningMessage(
            `Backup before delete failed for "${basenameRemote(remotePath)}".`,
            { modal: true, detail: `${formatError(err)}\n\nDelete anyway without a safety copy?` },
            'Delete Anyway'
          );
          if (answer !== 'Delete Anyway') {
            throw vscode.FileSystemError.Unavailable('Delete cancelled — backup failed.');
          }
        }
      }
      await conn.remove(remotePath, entry.type === 'directory' ? 'directory' : 'file');
      this.deps.tracker.drop(uri.toString());
      this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
      this.deps.logger.info(`[${profile.name}] deleted ${remotePath}`);
    } catch (err) {
      throw this.toFsError(err, uri);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
    const from = this.ctx(oldUri);
    const to = this.ctx(newUri);
    this.assertWritable(from.profile);
    if (from.profile.id !== to.profile.id) {
      throw vscode.FileSystemError.Unavailable('Cannot rename across different servers.');
    }
    try {
      if (!options.overwrite && (await this.exists(to.conn, to.remotePath))) {
        throw vscode.FileSystemError.FileExists(newUri);
      }
      await from.conn.rename(from.remotePath, to.remotePath);
      this.deps.tracker.move(oldUri.toString(), newUri.toString());
      this.emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri }
      ]);
      this.deps.logger.info(`[${from.profile.name}] renamed ${from.remotePath} → ${to.remotePath}`);
    } catch (err) {
      throw this.toFsError(err, oldUri);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { profile, conn, remotePath } = this.ctx(uri);
    this.assertWritable(profile);
    try {
      await conn.mkdir(remotePath);
      this.emitter.fire([
        { type: vscode.FileChangeType.Changed, uri: uri.with({ path: dirnameRemote(remotePath) }) },
        { type: vscode.FileChangeType.Created, uri }
      ]);
    } catch (err) {
      throw this.toFsError(err, uri);
    }
  }
}
