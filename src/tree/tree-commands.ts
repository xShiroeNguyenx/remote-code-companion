import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection-manager';
import { SCHEME } from '../constants';
import { formatError, Logger } from '../core/logger';
import { basenameRemote, joinRemote, parseRccParts, rccUri, remoteSnapshotUri } from '../fs/uri';
import { log } from '../log';
import { pickRemote } from '../profiles/remote-commands';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { reportConnectionFailure } from '../profiles/tls-advice';
import { RemoteTreeProvider } from './remote-tree-provider';
import { RemoteNode } from './types';

export interface TreeCommandDeps {
  store: RemoteConfigStore;
  manager: ConnectionManager;
  tree: RemoteTreeProvider;
  logger: Logger;
  /** Drops the connection after a config fix so the next attempt uses it. */
  onConfigSaved(profileId: string): Promise<void>;
}

function nodeUri(node: RemoteNode): vscode.Uri {
  return rccUri(node.profileId, node.path);
}

async function resolveProfileId(
  arg: unknown,
  store: RemoteConfigStore,
  title: string
): Promise<{ profileId: string; node?: RemoteNode } | undefined> {
  const node = arg as RemoteNode | undefined;
  if (node?.profileId) {
    return { profileId: node.profileId, node };
  }
  const config = await pickRemote(store, title);
  return config ? { profileId: config.id } : undefined;
}

/** Name validation for new files/folders/renames. */
function validateEntryName(value: string): string | undefined {
  const v = value.trim();
  if (!v) {
    return 'Name is required';
  }
  if (v === '.' || v === '..' || v.includes('/') || v.includes('\\')) {
    return 'Name must not contain path separators';
  }
  return undefined;
}

export function registerTreeCommands(deps: TreeCommandDeps): vscode.Disposable[] {
  const { store, manager, tree, logger } = deps;

  const withErrorToast = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (err) {
      if (err instanceof vscode.FileSystemError && /cancelled/i.test(err.message)) {
        return; // user cancelled inside the pipeline — not an error
      }
      logger.error('command failed', err);
      void vscode.window.showErrorMessage(formatError(err));
    }
  };

  return [
    vscode.commands.registerCommand('remoteCodeCompanion.openFile', async (arg?: RemoteNode | vscode.Uri) => {
      const uri = arg instanceof vscode.Uri ? arg : arg ? nodeUri(arg) : undefined;
      if (uri) {
        await vscode.commands.executeCommand('vscode.open', uri);
      }
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.refresh', (node?: RemoteNode) => {
      if (node && node.kind !== 'file') {
        const conn = manager.getConnection(node.profileId);
        conn.invalidateSubtree(node.path);
        tree.refresh(node);
      } else {
        for (const profile of store.all()) {
          try {
            manager.getConnection(profile.id).invalidateAll();
          } catch {
            // connection may not exist yet
          }
        }
        tree.refresh();
      }
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.connect', async (arg?: unknown) => {
      const resolved = await resolveProfileId(arg, store, 'Connect to which server?');
      if (!resolved) {
        return;
      }
      const profile = store.get(resolved.profileId);
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Window, title: `Connecting to ${profile?.name ?? 'server'}...` },
          () => manager.connect(resolved.profileId)
        );
        tree.refresh();
      } catch (err) {
        // A failed connection is nearly always a fixable config mistake, so it
        // gets the same guided treatment as Test connection.
        if (!profile) {
          void vscode.window.showErrorMessage(formatError(err));
          return;
        }
        logger.error(`connecting to ${profile.name} failed`, err);
        await reportConnectionFailure(profile, formatError(err), {
          store,
          logger,
          onConfigSaved: deps.onConfigSaved
        });
      }
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.disconnect', async (arg?: unknown) => {
      const resolved = await resolveProfileId(arg, store, 'Disconnect from which server?');
      if (!resolved) {
        return;
      }
      await manager.disconnect(resolved.profileId);
      tree.refresh();
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.diffWithServer', async (arg?: RemoteNode | vscode.Uri) => {
      let uri: vscode.Uri | undefined;
      if (arg instanceof vscode.Uri) {
        uri = arg;
      } else if (arg && (arg as RemoteNode).kind === 'file') {
        uri = nodeUri(arg as RemoteNode);
      } else {
        uri = vscode.window.activeTextEditor?.document.uri;
      }
      if (!uri || uri.scheme !== SCHEME) {
        void vscode.window.showInformationMessage('Open a remote file (from the Remote Explorer) first.');
        return;
      }
      const { profileId, remotePath } = parseRccParts(uri);
      const profile = store.get(profileId);
      await withErrorToast(async () => {
        await vscode.commands.executeCommand(
          'vscode.diff',
          remoteSnapshotUri(profileId, remotePath),
          uri,
          `Server${profile ? ` (${profile.name})` : ''} ↔ Your copy: ${basenameRemote(remotePath)}`
        );
      });
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.newFile', async (arg?: RemoteNode) => {
      const resolved = await resolveProfileId(arg, store, 'Create a file on which server?');
      if (!resolved) {
        return;
      }
      const dirPath = resolved.node?.path ?? store.get(resolved.profileId)?.remoteRoot ?? '/';
      const name = await vscode.window.showInputBox({
        title: `New file in ${dirPath}`,
        placeHolder: 'filename.php',
        ignoreFocusOut: true,
        validateInput: validateEntryName
      });
      if (!name) {
        return;
      }
      const uri = rccUri(resolved.profileId, joinRemote(dirPath, name.trim()));
      await withErrorToast(async () => {
        try {
          await vscode.workspace.fs.stat(uri);
          void vscode.window.showErrorMessage(`"${name.trim()}" already exists.`);
          return;
        } catch {
          // good — it does not exist yet
        }
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
        tree.refresh(resolved.node);
        await vscode.commands.executeCommand('vscode.open', uri);
      });
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.newFolder', async (arg?: RemoteNode) => {
      const resolved = await resolveProfileId(arg, store, 'Create a folder on which server?');
      if (!resolved) {
        return;
      }
      const dirPath = resolved.node?.path ?? store.get(resolved.profileId)?.remoteRoot ?? '/';
      const name = await vscode.window.showInputBox({
        title: `New folder in ${dirPath}`,
        placeHolder: 'folder-name',
        ignoreFocusOut: true,
        validateInput: validateEntryName
      });
      if (!name) {
        return;
      }
      await withErrorToast(async () => {
        await vscode.workspace.fs.createDirectory(rccUri(resolved.profileId, joinRemote(dirPath, name.trim())));
        tree.refresh(resolved.node);
      });
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.rename', async (node?: RemoteNode) => {
      if (!node || node.kind === 'profile') {
        return;
      }
      const newName = await vscode.window.showInputBox({
        title: `Rename ${node.name}`,
        value: node.name,
        ignoreFocusOut: true,
        validateInput: validateEntryName
      });
      if (!newName || newName.trim() === node.name) {
        return;
      }
      const target = rccUri(node.profileId, joinRemote(path.posix.dirname(node.path), newName.trim()));
      await withErrorToast(async () => {
        await vscode.workspace.fs.rename(nodeUri(node), target);
        tree.refresh();
      });
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.delete', async (node?: RemoteNode) => {
      if (!node || node.kind === 'profile') {
        return;
      }
      const profile = store.get(node.profileId);
      const answer = await vscode.window.showWarningMessage(
        `Delete "${node.name}" from ${profile?.name ?? 'the server'}?`,
        {
          modal: true,
          detail:
            node.kind === 'dir'
              ? `${node.path}\n\nThe folder and EVERYTHING inside it will be deleted on the server. This cannot be undone from a backup.`
              : `${node.path}\n\nA backup of the file is kept locally before deletion.`
        },
        'Delete'
      );
      if (answer !== 'Delete') {
        return;
      }
      await withErrorToast(async () => {
        await vscode.workspace.fs.delete(nodeUri(node), { recursive: node.kind === 'dir', useTrash: false });
        tree.refresh();
      });
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.downloadFile', async (node?: RemoteNode) => {
      if (!node || node.kind !== 'file') {
        return;
      }
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(node.name),
        title: `Download ${node.path}`
      });
      if (!target) {
        return;
      }
      await withErrorToast(async () => {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Downloading ${node.name}...` },
          async () => {
            // Direct connection read — downloads are exempt from the open-size limit.
            const bytes = await manager.getConnection(node.profileId).readFile(node.path);
            await vscode.workspace.fs.writeFile(target, bytes);
          }
        );
        void vscode.window.showInformationMessage(`Downloaded ${node.name} to ${target.fsPath}`);
      });
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.uploadFileHere', async (arg?: RemoteNode) => {
      const resolved = await resolveProfileId(arg, store, 'Upload to which server?');
      if (!resolved) {
        return;
      }
      const dirPath = resolved.node?.path ?? store.get(resolved.profileId)?.remoteRoot ?? '/';
      const picked = await vscode.window.showOpenDialog({ canSelectMany: false, title: `Upload a file to ${dirPath}` });
      if (!picked || picked.length === 0) {
        return;
      }
      const local = picked[0];
      const fileName = path.basename(local.fsPath);
      const target = rccUri(resolved.profileId, joinRemote(dirPath, fileName));
      await withErrorToast(async () => {
        const bytes = await vscode.workspace.fs.readFile(local);
        // The save pipeline handles backup/confirm/conflict for existing targets.
        await vscode.workspace.fs.writeFile(target, bytes);
        tree.refresh(resolved.node);
        void vscode.window.showInformationMessage(`Uploaded ${fileName} to ${dirPath}`);
      });
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.copyRemotePath', async (node?: RemoteNode) => {
      if (node?.path) {
        await vscode.env.clipboard.writeText(node.path);
        void vscode.window.showInformationMessage(`Copied: ${node.path}`);
      }
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.showOutput', () => {
      log.show();
    })
  ];
}
