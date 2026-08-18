import * as vscode from 'vscode';
import { BackupManager } from '../backup/backup-manager';
import { config } from '../config';
import { ManagedConnection } from '../connection/connection-manager';
import { RemoteFileEntry } from '../connection/types';
import { RccError } from '../core/errors';
import { formatError, Logger } from '../core/logger';
import { basenameRemote } from '../core/remote-path';
import { FileStateTracker } from '../fs/file-state-tracker';
import { ServerProfile } from '../profiles/types';
import { isCriticalFile } from '../wordpress/wp-heuristics';
import { detectConflict } from './conflict-detector';

export interface SavePipelineDeps {
  tracker: FileStateTracker;
  backups: BackupManager;
  logger: Logger;
  /** Called after a verified upload, e.g. to flash the status bar. */
  onUploaded?(fileName: string): void;
}

function cancelled(reason: string): vscode.FileSystemError {
  return vscode.FileSystemError.Unavailable(`Save cancelled — ${reason}. Your changes are still in the editor.`);
}

/**
 * The ordered production-safety algorithm behind every write:
 * fresh stat → conflict check → backup → confirm → upload → verify → refresh baseline.
 * Both UX modes (tree and mounted workspace folder) funnel into this via
 * RemoteFsProvider.writeFile.
 */
export class SavePipeline {
  private readonly uriLocks = new Map<string, Promise<unknown>>();
  private readonly degradedWarned = new Set<string>();

  constructor(private readonly deps: SavePipelineDeps) {}

  async run(
    profile: ServerProfile,
    conn: ManagedConnection,
    uri: vscode.Uri,
    remotePath: string,
    content: Uint8Array
  ): Promise<{ created: boolean }> {
    // A second Ctrl+S while an upload runs queues behind the first.
    const key = uri.toString();
    const previous = this.uriLocks.get(key) ?? Promise.resolve();
    const task = previous.then(() => this.runLocked(profile, conn, uri, remotePath, content));
    this.uriLocks.set(
      key,
      task.then(
        () => undefined,
        () => undefined
      )
    );
    return task;
  }

  private async runLocked(
    profile: ServerProfile,
    conn: ManagedConnection,
    uri: vscode.Uri,
    remotePath: string,
    content: Uint8Array
  ): Promise<{ created: boolean }> {
    const fileName = basenameRemote(remotePath);
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Uploading ${fileName} to ${profile.name}...` },
      async () => {
        const effectiveConfirm = profile.confirmOnSave ?? config.confirmOnSave();
        const effectiveBackup = profile.backupOnSave ?? config.backupEnabled();

        // 1. Fresh stat — one network op reused by conflict check and create detection.
        let fresh: RemoteFileEntry | undefined;
        try {
          fresh = await conn.stat(remotePath);
        } catch (err) {
          if (err instanceof RccError && err.code === 'FileNotFound') {
            fresh = undefined; // it's a create
          } else {
            throw err;
          }
        }
        if (fresh?.type === 'directory') {
          throw vscode.FileSystemError.FileIsADirectory(uri);
        }
        const created = fresh === undefined;

        if (fresh) {
          // 2. Conflict check against the baseline captured when the file was opened.
          if (config.conflictCheck()) {
            await this.checkConflict(profile, uri, remotePath, fresh);
          }
          // 3. Backup the current server bytes BEFORE overwriting them.
          if (effectiveBackup) {
            await this.backupCurrent(profile, conn, remotePath);
          }
        }

        // 4. Confirm. Critical WordPress files always ask, regardless of the toggle.
        const critical = config.warnCriticalFiles() && isCriticalFile(remotePath);
        if (effectiveConfirm || critical) {
          const detail = critical
            ? `${remotePath}\n\nThis is a critical file — a bad upload can take the whole site down.`
            : remotePath;
          const answer = await vscode.window.showWarningMessage(
            `Upload "${fileName}" to ${profile.name} (${profile.host})?`,
            { modal: true, detail },
            'Upload'
          );
          if (answer !== 'Upload') {
            throw cancelled('upload not confirmed');
          }
        }

        // 5. Upload.
        await conn.writeFile(remotePath, Buffer.from(content));

        // 6. Verify + refresh baseline.
        try {
          const after = await conn.stat(remotePath);
          if (after.size !== content.byteLength) {
            void vscode.window.showWarningMessage(
              `Upload of ${fileName} may be incomplete: server reports ${after.size} bytes, expected ${content.byteLength}. A backup of the previous version was kept.`
            );
          }
          this.deps.tracker.capture(uri.toString(), after);
        } catch (err) {
          this.deps.logger.warn(`post-upload verify failed for ${remotePath}: ${formatError(err)}`);
          this.deps.tracker.drop(uri.toString());
        }

        this.deps.logger.info(`[${profile.name}] uploaded ${remotePath} (${content.byteLength} bytes)`);
        this.deps.onUploaded?.(fileName);
        return { created };
      }
    );
  }

  private async checkConflict(
    profile: ServerProfile,
    uri: vscode.Uri,
    remotePath: string,
    fresh: RemoteFileEntry
  ): Promise<void> {
    const baseline = this.deps.tracker.get(uri.toString());
    if (!baseline) {
      return; // nothing to compare against (file never read in this session)
    }
    const verdict = detectConflict(baseline, fresh);
    if (verdict.degraded && !this.degradedWarned.has(profile.id)) {
      this.degradedWarned.add(profile.id);
      this.deps.logger.warn(
        `[${profile.name}] conflict detection is degraded on this server (${verdict.reason}) — size is the only reliable signal`
      );
    }
    if (!verdict.conflict) {
      return;
    }
    const fileName = basenameRemote(remotePath);
    const answer = await vscode.window.showWarningMessage(
      `"${fileName}" changed on the server since you opened it.`,
      {
        modal: true,
        detail: `${verdict.reason}.\n\nOverwriting will discard whatever was changed on the server.`
      },
      'Overwrite',
      'Diff with Server'
    );
    if (answer === 'Overwrite') {
      return;
    }
    if (answer === 'Diff with Server') {
      void vscode.commands.executeCommand('remoteCodeCompanion.diffWithServer', uri);
      throw cancelled('review the diff, then save again');
    }
    throw cancelled('file changed on server');
  }

  private async backupCurrent(profile: ServerProfile, conn: ManagedConnection, remotePath: string): Promise<void> {
    try {
      const current = await conn.readFile(remotePath);
      await this.deps.backups.write(profile.id, remotePath, current, 'pre-save');
    } catch (err) {
      const message = formatError(err);
      this.deps.logger.error(`backup before save failed for ${remotePath}`, err);
      if (!config.backupRequired()) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Backup failed — the current server version of "${basenameRemote(remotePath)}" could not be downloaded.`,
        { modal: true, detail: `${message}\n\nSaving anyway will overwrite the server file without a safety copy.` },
        'Save Anyway'
      );
      if (answer !== 'Save Anyway') {
        throw cancelled('backup failed');
      }
    }
  }
}
