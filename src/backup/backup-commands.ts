import * as vscode from 'vscode';
import { SCHEME } from '../constants';
import { Logger } from '../core/logger';
import { basenameRemote, parseRccParts, rccUri, remoteSnapshotUri } from '../fs/uri';
import { pickRemote } from '../profiles/remote-commands';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { BackupManager } from './backup-manager';
import { BackupEntry } from './types';

export interface BackupCommandDeps {
  store: RemoteConfigStore;
  backups: BackupManager;
  logger: Logger;
}

function entryLabel(entry: BackupEntry): string {
  const when = new Date(entry.timestamp).toLocaleString();
  return `${when} · ${entry.size} bytes · ${entry.reason}`;
}

async function restoreEntry(entry: BackupEntry, backups: BackupManager): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    `Restore "${basenameRemote(entry.remotePath)}" to the server?`,
    {
      modal: true,
      detail: `Backup from ${new Date(entry.timestamp).toLocaleString()} (${entry.size} bytes) will be uploaded to:\n${entry.remotePath}\n\nThe current server version is backed up first, so this is undoable.`
    },
    'Restore'
  );
  if (answer !== 'Restore') {
    return;
  }
  const bytes = await backups.read(entry);
  // Writing through workspace.fs routes through RemoteFsProvider → the full
  // save pipeline, which backs up the current server state before overwriting.
  await vscode.workspace.fs.writeFile(rccUri(entry.profileId, entry.remotePath), bytes);
  void vscode.window.showInformationMessage(`Restored ${basenameRemote(entry.remotePath)} from backup.`);
}

export function registerBackupCommands(deps: BackupCommandDeps): vscode.Disposable[] {
  const { store, backups } = deps;

  return [
    vscode.commands.registerCommand('remoteCodeCompanion.browseBackups', async () => {
      const profile = await pickRemote(store, 'Browse backups of which remote?');
      if (!profile) {
        return;
      }
      const all = await backups.listAll(profile.id);
      if (all.length === 0) {
        void vscode.window.showInformationMessage(`No backups yet for "${profile.name}".`);
        return;
      }
      const byFile = new Map<string, BackupEntry[]>();
      for (const entry of all) {
        const list = byFile.get(entry.remotePath) ?? [];
        list.push(entry);
        byFile.set(entry.remotePath, list);
      }
      const filePick = await vscode.window.showQuickPick(
        [...byFile.entries()].map(([remotePath, entries]) => ({
          label: basenameRemote(remotePath),
          description: remotePath,
          detail: `${entries.length} backup(s), newest ${new Date(entries[0].timestamp).toLocaleString()}`,
          remotePath
        })),
        { title: `Backups on "${profile.name}"`, matchOnDescription: true, ignoreFocusOut: true }
      );
      if (!filePick) {
        return;
      }
      const entryPick = await vscode.window.showQuickPick(
        (byFile.get(filePick.remotePath) ?? []).map((entry) => ({ label: entryLabel(entry), entry })),
        { title: filePick.remotePath, ignoreFocusOut: true }
      );
      if (!entryPick) {
        return;
      }
      const entry = entryPick.entry;
      const action = await vscode.window.showQuickPick(
        [
          { label: '$(eye) Open backup', action: 'open' },
          { label: '$(diff) Diff backup vs current server version', action: 'diff' },
          { label: '$(cloud-upload) Restore to server', action: 'restore' },
          { label: '$(folder-opened) Reveal in File Explorer', action: 'reveal' },
          { label: '$(trash) Delete this backup', action: 'delete' }
        ],
        { title: entryLabel(entry), ignoreFocusOut: true }
      );
      if (!action) {
        return;
      }
      const backupFileUri = vscode.Uri.file(backups.backupFilePath(entry));
      switch (action.action) {
        case 'open':
          await vscode.commands.executeCommand('vscode.open', backupFileUri);
          break;
        case 'diff':
          await vscode.commands.executeCommand(
            'vscode.diff',
            backupFileUri,
            remoteSnapshotUri(entry.profileId, entry.remotePath),
            `Backup ${new Date(entry.timestamp).toLocaleString()} ↔ Server: ${basenameRemote(entry.remotePath)}`
          );
          break;
        case 'restore':
          await restoreEntry(entry, backups);
          break;
        case 'reveal':
          await vscode.commands.executeCommand('revealFileInOS', backupFileUri);
          break;
        case 'delete':
          await backups.deleteEntry(entry);
          void vscode.window.showInformationMessage('Backup deleted.');
          break;
      }
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.restoreLatestBackup', async (arg?: vscode.Uri) => {
      const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== SCHEME) {
        void vscode.window.showInformationMessage('Open a remote file (rcc://) first, then run Restore Latest Backup.');
        return;
      }
      const { profileId, remotePath } = parseRccParts(uri);
      const latest = await backups.latestFor(profileId, remotePath);
      if (!latest) {
        void vscode.window.showInformationMessage(`No backups recorded for ${remotePath}.`);
        return;
      }
      await restoreEntry(latest, backups);
    })
  ];
}
