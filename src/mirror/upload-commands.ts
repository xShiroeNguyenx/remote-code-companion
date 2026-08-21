import * as fs from 'fs';
import * as vscode from 'vscode';
import { config as settings } from '../config';
import { SCHEME } from '../constants';
import { formatError, Logger } from '../core/logger';
import { basenameRemote } from '../core/remote-path';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { protocolLabel, RemoteConfig } from '../profiles/types';
import { DialogTarget, UploadDialogModel } from '../ui/upload-dialog-view';
import { UploadDialog } from '../ui/upload-dialog';
import { isCriticalFile } from '../wordpress/wp-heuristics';
import { localPathFor } from './manifest';
import { localTarget } from './local-target';
import { gateOnPhpSyntax, reportPushResult } from './push-support';
import { SyncEngine } from './sync-engine';
import { FileStatus, SyncState } from './types';

/**
 * "I know exactly which file I changed — send that one." The push command
 * answers a different question (what is out of sync anywhere?) and pays for it
 * with a stat per tracked file, which on a mirrored theme is a long wait for an
 * answer the user already had.
 *
 * Everything still goes through the save pipeline: backup, conflict check,
 * confirmation, upload, size verification. What is skipped is the *scan*, never
 * a safety step.
 */

export interface UploadCommandDeps {
  store: RemoteConfigStore;
  engine: SyncEngine;
  logger: Logger;
  /** Injectable for tests; the same webview dialog the pipeline uses. */
  dialog?: UploadDialog;
}

/**
 * A folder upload sends what differs, not everything it contains. Re-uploading
 * hundreds of byte-identical files over one FTP connection is how a host's
 * flood protection gets tripped, and it changes nothing on the server.
 */
const FOLDER_UPLOADABLE: SyncState[] = [
  'localChanged',
  'created',
  'bothChanged',
  'createdBoth',
  'remoteMissing'
];

/** States with no local bytes to send; naming them beats a silent no-op. */
const NOTHING_TO_SEND: SyncState[] = ['localMissing', 'bothMissing'];

interface Group {
  config: RemoteConfig;
  statuses: FileStatus[];
}

function localSize(folderPath: string, localRelPath: string): number {
  try {
    return fs.statSync(localPathFor(folderPath, localRelPath)).size;
  } catch {
    return 0;
  }
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

/** The URIs a menu invocation is about: a multi-selection, one item, or the editor. */
function requested(uri?: vscode.Uri, uris?: vscode.Uri[]): vscode.Uri[] {
  if (uris && uris.length > 0) {
    return uris;
  }
  if (uri) {
    return [uri];
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  return active ? [active] : [];
}

/**
 * A live rcc:// document is already "the server copy" — saving it uploads. Say
 * that instead of inventing a second way to do the same thing.
 */
async function handleRemoteDocument(uri: vscode.Uri): Promise<void> {
  const open = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
  if (open?.isDirty) {
    await open.save();
    return;
  }
  const answer = await vscode.window.showInformationMessage(
    `"${basenameRemote(uri.path)}" is open live from the server — it has no unsaved changes to upload.`,
    'Diff with Server'
  );
  if (answer === 'Diff with Server') {
    await vscode.commands.executeCommand('remoteCodeCompanion.diffWithServer', uri);
  }
}

export function registerUploadCommands(deps: UploadCommandDeps): vscode.Disposable[] {
  const { store, engine, logger } = deps;
  const dialog = deps.dialog ?? new UploadDialog();

  /** Group the requested URIs by the remote that owns them, expanding folders. */
  const resolve = async (uris: vscode.Uri[]): Promise<{ groups: Group[]; skipped: string[] }> => {
    const buckets = new Map<string, { config: RemoteConfig; folderPath: string; files: Set<string>; dirs: string[] }>();
    const skipped: string[] = [];

    for (const uri of uris) {
      if (uri.scheme === SCHEME) {
        await handleRemoteDocument(uri);
        continue;
      }
      const target = localTarget(store, uri);
      if (!target) {
        skipped.push(`${uri.fsPath} — not inside a folder with a remote`);
        continue;
      }
      if (target.localRelPath.startsWith('.rcc/') || target.localRelPath === '.rcc') {
        skipped.push(`${target.localRelPath} — the extension's own folder is never uploaded`);
        continue;
      }
      let bucket = buckets.get(target.config.id);
      if (!bucket) {
        bucket = { config: target.config, folderPath: target.folder.uri.fsPath, files: new Set(), dirs: [] };
        buckets.set(target.config.id, bucket);
      }
      if (await isDirectory(uri)) {
        bucket.dirs.push(target.localRelPath);
      } else {
        bucket.files.add(target.localRelPath);
      }
    }

    const groups: Group[] = [];
    for (const bucket of buckets.values()) {
      if (bucket.config.readOnly) {
        skipped.push(`"${bucket.config.name}" is read-only — nothing was uploaded to it`);
        continue;
      }
      const statuses = new Map<string, FileStatus>();

      // Named files go up whatever their state: the user picked them. An
      // unchanged one still costs a transfer, and re-uploading it is sometimes
      // exactly the point — after a botched deploy, or a file edited on the
      // server by someone else.
      for (const status of await engine.statusOfPaths(bucket.config, [...bucket.files])) {
        if (NOTHING_TO_SEND.includes(status.state)) {
          skipped.push(`${status.localRelPath} — ${status.reason}`);
          continue;
        }
        statuses.set(status.remotePath, status);
      }

      for (const dir of bucket.dirs) {
        for (const status of await engine.statusUnder(bucket.config, dir)) {
          if (FOLDER_UPLOADABLE.includes(status.state)) {
            statuses.set(status.remotePath, status);
          }
        }
      }

      if (statuses.size > 0) {
        groups.push({
          config: bucket.config,
          statuses: [...statuses.values()].sort((a, b) => a.localRelPath.localeCompare(b.localRelPath))
        });
      } else if (bucket.dirs.length > 0) {
        void vscode.window.showInformationMessage(
          `Nothing to upload from ${bucket.dirs.map((d) => d || bucket.config.name).join(', ')} — every file there matches ${
            bucket.config.name
          }.`
        );
      }
    }
    return { groups, skipped };
  };

  /**
   * One question for one action. A single file is confirmed by the pipeline
   * itself, which knows the backup and conflict outcome; a multi-file selection
   * is confirmed once here, and the pipeline then only stops for the files
   * where something is actually wrong.
   */
  const confirmBatch = async (group: Group): Promise<boolean> => {
    const folder = store.folderFor(group.config.id);
    const folderPath = folder?.uri.fsPath ?? '';
    const targets: DialogTarget[] = group.statuses.map((status) => ({
      remotePath: status.remotePath,
      fileName: basenameRemote(status.remotePath),
      size: localSize(folderPath, status.localRelPath),
      created: status.state === 'created',
      critical: isCriticalFile(status.remotePath)
    }));

    const conflicted = group.statuses.filter((s) => s.state === 'bothChanged' || s.state === 'createdBoth');
    const model: UploadDialogModel = {
      profileName: group.config.name,
      host: group.config.host,
      protocolLabel: protocolLabel(group.config.protocol),
      origin: 'Upload to Server',
      targets,
      facts: [
        {
          kind: 'info',
          text: 'Every file still goes through backup, conflict check, upload and size verification.'
        },
        ...(conflicted.length > 0
          ? [
              {
                kind: 'warn' as const,
                text: `${conflicted.length} of them also changed on the server — each of those asks again, on its own.`
              }
            ]
          : [])
      ],
      canDiff: false,
      footnote: 'Files identical to the server were left out.'
    };

    const decision = await dialog.ask(model);
    return decision.answer === 'upload';
  };

  const run = async (uris: vscode.Uri[]): Promise<void> => {
    if (uris.length === 0) {
      void vscode.window.showInformationMessage(
        'Nothing selected to upload — right-click a file in the Explorer, or open it first.'
      );
      return;
    }

    const { groups, skipped } = await resolve(uris);
    for (const note of skipped) {
      logger.info(`[upload] skipped ${note}`);
    }
    if (groups.length === 0) {
      if (skipped.length > 0) {
        void vscode.window.showWarningMessage(`Nothing uploaded: ${skipped[0]}.`);
      }
      return;
    }

    for (const group of groups) {
      const allowed = await gateOnPhpSyntax(store, group.config, group.statuses, logger);
      if (!allowed || allowed.length === 0) {
        continue;
      }

      // A batch is confirmed once, here; a single file is confirmed by the
      // pipeline, which by then knows whether the backup worked.
      const many = allowed.length > 1;
      const confirmSetting = group.config.confirmOnSave ?? settings.confirmOnSave();
      if (many && confirmSetting && !(await confirmBatch({ config: group.config, statuses: allowed }))) {
        continue;
      }

      const result = await engine.push(group.config, allowed, {
        force: true,
        origin: 'Upload to Server',
        preConfirmed: many && confirmSetting
      });
      reportPushResult(group.config.name, result, logger);
    }
  };

  const withErrors = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (err) {
      logger.error('upload command failed', err);
      void vscode.window.showErrorMessage(formatError(err));
    }
  };

  return [
    vscode.commands.registerCommand(
      'remoteCodeCompanion.uploadToServer',
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        await withErrors(() => run(requested(uri, uris)));
      }
    ),
    vscode.commands.registerCommand(
      'remoteCodeCompanion.uploadFolderToServer',
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        await withErrors(() => run(requested(uri, uris)));
      }
    )
  ];
}
