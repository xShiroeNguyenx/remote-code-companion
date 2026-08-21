import * as vscode from 'vscode';
import { BackupManager } from '../backup/backup-manager';
import { config } from '../config';
import { ManagedConnection } from '../connection/connection-manager';
import { RemoteFileEntry } from '../connection/types';
import { RccError } from '../core/errors';
import { formatError, Logger } from '../core/logger';
import { basenameRemote } from '../core/remote-path';
import { FileStateTracker } from '../fs/file-state-tracker';
import { remoteSnapshotUri } from '../fs/uri';
import { protocolLabel, ServerProfile } from '../profiles/types';
import { changeSummary } from '../ui/diff-summary';
import { UploadDecision, UploadDialog } from '../ui/upload-dialog';
import { DialogFact, formatBytes, UploadDialogModel } from '../ui/upload-dialog-view';
import { isCriticalFile } from '../wordpress/wp-heuristics';
import { detectConflict } from './conflict-detector';

/**
 * What the caller knows and the file system API cannot carry. `workspace.fs.writeFile`
 * takes bytes and nothing else, so a push that already checked the sync state
 * leaves its findings here, keyed by URI, for the pipeline to fold into one
 * dialog instead of stacking a second one on top of its own.
 */
export interface UploadIntent {
  /** Why this upload is happening — "Push · 2 of 7", "Right-click upload". */
  origin?: string;
  /** Risks the caller established; each one forces the confirmation. */
  warnings?: string[];
  /** The caller already had the user confirm this exact list of files. */
  confirmed?: boolean;
  /** The local file the bytes came from, so "Diff with Server" compares the real pair. */
  localUri?: vscode.Uri;
}

export interface SavePipelineDeps {
  tracker: FileStateTracker;
  backups: BackupManager;
  logger: Logger;
  /** Called after a verified upload, e.g. to flash the status bar. */
  onUploaded?(fileName: string): void;
  /** The dialog's "stop asking" checkbox: writes the per-remote override. */
  onSuppressConfirm?(profileId: string): Promise<void>;
  /** Injectable for tests; the webview dialog by default. */
  dialog?: UploadDialog;
}

interface BackupAttempt {
  /** The server bytes, when they were downloaded — reused for the change summary. */
  bytes?: Buffer;
  failure?: string;
}

function cancelled(reason: string): vscode.FileSystemError {
  return vscode.FileSystemError.Unavailable(`Save cancelled — ${reason}. Your changes are still in the editor.`);
}

/**
 * The ordered production-safety algorithm behind every write:
 * fresh stat → conflict check → backup → confirm → upload → verify → refresh baseline.
 * Both UX modes (tree and mounted workspace folder) funnel into this via
 * RemoteFsProvider.writeFile.
 *
 * The confirmation is one dialog, not a chain of them: whatever the earlier
 * steps found — a server-side change, a failed backup, a critical file — is
 * shown as part of the single question "upload this?". A user answering three
 * modals in a row stops reading them, which is the opposite of a safety net.
 */
export class SavePipeline {
  private readonly uriLocks = new Map<string, Promise<unknown>>();
  private readonly degradedWarned = new Set<string>();
  private readonly intents = new Map<string, UploadIntent>();
  private readonly dialog: UploadDialog;

  constructor(private readonly deps: SavePipelineDeps) {
    this.dialog = deps.dialog ?? new UploadDialog();
  }

  /** Declared just before writing the same URI; consumed by that write. */
  declareIntent(uri: vscode.Uri | string, intent: UploadIntent): void {
    this.intents.set(typeof uri === 'string' ? uri : uri.toString(), intent);
  }

  /**
   * Withdraw an intent whose write never reached the pipeline. Left behind, a
   * stale "already confirmed" flag would silence the confirmation for a *later*
   * save of the same file — the one place where a leak becomes a safety hole.
   */
  dropIntent(uri: vscode.Uri | string): void {
    this.intents.delete(typeof uri === 'string' ? uri : uri.toString());
  }

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
    const intent = this.intents.get(uri.toString());
    this.intents.delete(uri.toString());

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

        // What the dialog will report, gathered as the steps run.
        const facts: DialogFact[] = [];
        // Anything risky makes the dialog unskippable, whatever the setting says.
        let mustAsk = false;
        let serverBytes: Buffer | undefined;
        let conflicted = false;

        if (fresh) {
          // 2. Conflict check against the baseline captured when the file was opened.
          if (config.conflictCheck()) {
            const verdict = this.conflictOf(profile, uri, fresh);
            if (verdict) {
              conflicted = true;
              mustAsk = true;
              facts.push({
                kind: 'warn',
                text: `${verdict}. Uploading discards whatever was changed on the server.`
              });
            }
          }
          // 3. Backup the current server bytes BEFORE overwriting them. The
          // download also gives the dialog something to compare against, which
          // is why it now runs before the question rather than after it.
          if (effectiveBackup) {
            const attempt = await this.backupCurrent(profile, conn, remotePath);
            if (attempt.bytes) {
              serverBytes = attempt.bytes;
              facts.push({ kind: 'ok', text: 'Current server version backed up before overwriting it.' });
            } else if (attempt.failure) {
              const required = config.backupRequired();
              mustAsk = mustAsk || required;
              facts.push({
                kind: required ? 'warn' : 'info',
                text: `Backup failed (${attempt.failure}) — uploading overwrites the server file with no safety copy.`
              });
            }
          } else {
            facts.push({
              kind: 'info',
              text: 'Backups are off for this remote, so the current server version will not be kept.'
            });
          }
        }

        // 4. Confirm. Critical WordPress files always ask, regardless of the toggle.
        const critical = config.warnCriticalFiles() && isCriticalFile(remotePath);
        if (critical) {
          mustAsk = true;
          facts.push({
            kind: 'warn',
            text: 'Critical file: a bad upload here does not degrade the site, it blanks every page of it.'
          });
        }
        for (const warning of intent?.warnings ?? []) {
          mustAsk = true;
          facts.push({ kind: 'warn', text: warning });
        }

        if (mustAsk || (effectiveConfirm && intent?.confirmed !== true)) {
          const model: UploadDialogModel = {
            profileName: profile.name,
            host: profile.host,
            protocolLabel: protocolLabel(profile.protocol),
            origin: intent?.origin,
            targets: [
              {
                remotePath,
                fileName,
                size: content.byteLength,
                serverSize: fresh?.size,
                delta: changeSummary(serverBytes, content),
                created,
                critical
              }
            ],
            facts,
            canDiff: !created,
            // Offering to silence the dialog is only honest when it is up because
            // of the setting, not because something about this file is risky.
            suppressLabel: mustAsk ? undefined : `Stop asking for "${profile.name}" — upload on save from now on`
          };

          const decision =
            config.confirmStyle() === 'modal' ? await this.askModal(model) : await this.dialog.ask(model);

          if (decision.answer === 'diff') {
            await this.openDiff(profile, uri, remotePath, intent?.localUri);
            throw cancelled('review the diff, then save again');
          }
          if (decision.answer !== 'upload') {
            throw cancelled(conflicted ? 'file changed on the server' : 'upload not confirmed');
          }
          if (decision.suppress) {
            await this.suppressConfirm(profile);
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

  /** The reason the server copy moved, or undefined when it did not. */
  private conflictOf(profile: ServerProfile, uri: vscode.Uri, fresh: RemoteFileEntry): string | undefined {
    const baseline = this.deps.tracker.get(uri.toString());
    if (!baseline) {
      return undefined; // nothing to compare against (file never read in this session)
    }
    const verdict = detectConflict(baseline, fresh);
    if (verdict.degraded && !this.degradedWarned.has(profile.id)) {
      this.degradedWarned.add(profile.id);
      this.deps.logger.warn(
        `[${profile.name}] conflict detection is degraded on this server (${verdict.reason}) — size is the only reliable signal`
      );
    }
    return verdict.conflict ? verdict.reason : undefined;
  }

  /**
   * "Diff with Server" means different pairs depending on where the bytes came
   * from: the local file for a push, the open remote document for a direct save.
   */
  private async openDiff(
    profile: ServerProfile,
    uri: vscode.Uri,
    remotePath: string,
    localUri: vscode.Uri | undefined
  ): Promise<void> {
    if (localUri) {
      await vscode.commands.executeCommand(
        'vscode.diff',
        remoteSnapshotUri(profile.id, remotePath),
        localUri,
        `Server (${profile.name}) ↔ Local: ${basenameRemote(remotePath)}`
      );
      return;
    }
    await vscode.commands.executeCommand('remoteCodeCompanion.diffWithServer', uri);
  }

  /** The escape hatch from the dialog itself, written where the remote is declared. */
  private async suppressConfirm(profile: ServerProfile): Promise<void> {
    if (!this.deps.onSuppressConfirm) {
      return;
    }
    try {
      await this.deps.onSuppressConfirm(profile.id);
      this.deps.logger.info(`[${profile.name}] confirm-on-save turned off from the upload dialog`);
      void vscode.window
        .showInformationMessage(
          `Uploads to "${profile.name}" no longer ask for confirmation. Backups and conflict checks still run.`,
          'Settings'
        )
        .then((answer) => {
          if (answer === 'Settings') {
            void vscode.commands.executeCommand('remoteCodeCompanion.openSettings', { profileId: profile.id });
          }
        });
    } catch (err) {
      this.deps.logger.error(`could not turn off confirm-on-save for ${profile.name}`, err);
    }
  }

  /**
   * The same question as a native modal, for `confirm.style: modal`. It cannot
   * show the layout, so it spends its one detail block on the full remote path
   * and the facts — the two things the old one-line dialog lost.
   */
  private async askModal(model: UploadDialogModel): Promise<UploadDecision> {
    const target = model.targets[0];
    const sizes = [
      formatBytes(target.size),
      target.created ? 'new file' : target.serverSize !== undefined ? `replaces ${formatBytes(target.serverSize)}` : '',
      target.delta && (target.delta.added > 0 || target.delta.removed > 0)
        ? `+${target.delta.added} −${target.delta.removed} lines`
        : ''
    ].filter(Boolean);
    const detail = [
      target.remotePath,
      '',
      sizes.join('  ·  '),
      ...model.facts.map((fact) => `${fact.kind === 'ok' ? '✓' : fact.kind === 'warn' ? '⚠' : 'ℹ'} ${fact.text}`)
    ].join('\n');

    const diffLabel = 'Diff with Server';
    const answer = await vscode.window.showWarningMessage(
      `Upload "${target.fileName}" to ${model.profileName} (${model.host})?`,
      { modal: true, detail },
      'Upload',
      ...(model.canDiff ? [diffLabel] : [])
    );
    return { answer: answer === 'Upload' ? 'upload' : answer === diffLabel ? 'diff' : 'cancel', suppress: false };
  }

  private async backupCurrent(
    profile: ServerProfile,
    conn: ManagedConnection,
    remotePath: string
  ): Promise<BackupAttempt> {
    try {
      const current = await conn.readFile(remotePath);
      await this.deps.backups.write(profile.id, remotePath, current, 'pre-save');
      return { bytes: current };
    } catch (err) {
      const message = formatError(err);
      this.deps.logger.error(`backup before save failed for ${remotePath}`, err);
      return { failure: message };
    }
  }
}
