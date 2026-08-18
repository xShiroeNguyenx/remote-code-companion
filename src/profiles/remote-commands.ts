import * as vscode from 'vscode';
import { ConnectionManager } from '../connection/connection-manager';
import { Logger } from '../core/logger';
import { newProfileId } from '../core/rcc-uri';
import { configFromProfile, parseConfig, serializeConfig } from './config-file';
import { copyLegacyBackups, readLegacyProfiles, removeLegacyProfile } from './legacy-migration';
import { ProfileSecrets } from './profile-secrets';
import { RemoteConfigStore } from './remote-config-store';
import { runSetupWizard } from './setup-wizard';
import { protocolLabel, RemoteConfig } from './types';

export interface RemoteCommandDeps {
  context: vscode.ExtensionContext;
  store: RemoteConfigStore;
  secrets: ProfileSecrets;
  manager: ConnectionManager;
  logger: Logger;
}

/**
 * Palette fallback when a command is invoked without a tree node. With one
 * remote per folder this is usually a single-item list, so it resolves silently.
 */
export async function pickRemote(store: RemoteConfigStore, title: string): Promise<RemoteConfig | undefined> {
  const remotes = store.remotes();
  if (remotes.length === 0) {
    void vscode.window.showInformationMessage(
      'This folder has no remote. Run "Remote Code Companion: Set Up Remote for This Folder" first.'
    );
    return undefined;
  }
  if (remotes.length === 1) {
    return remotes[0].config;
  }
  const pick = await vscode.window.showQuickPick(
    remotes.map((r) => ({
      label: r.config.name,
      description: `${r.folder.name} · ${protocolLabel(r.config.protocol)} · ${r.config.host}`,
      config: r.config
    })),
    { title, ignoreFocusOut: true }
  );
  return pick?.config;
}

/** Which folder should a new remote be attached to? */
async function pickTargetFolder(store: RemoteConfigStore): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    void vscode.window.showWarningMessage(
      'Open a folder first — a remote belongs to a workspace folder, and its source is synced into it.'
    );
    return undefined;
  }
  const free = folders.filter((f) => !store.configIn(f));
  if (free.length === 0) {
    void vscode.window.showInformationMessage(
      'Every open folder already has a remote. Open Settings to change one.'
    );
    return undefined;
  }
  if (free.length === 1) {
    return free[0];
  }
  const pick = await vscode.window.showQuickPick(
    free.map((f) => ({ label: f.name, description: f.uri.fsPath, folder: f })),
    { title: 'Set up a remote for which folder?', ignoreFocusOut: true }
  );
  return pick?.folder;
}

export function registerRemoteCommands(deps: RemoteCommandDeps): vscode.Disposable[] {
  const { context, store, secrets, manager, logger } = deps;

  const folderOf = (config: RemoteConfig): vscode.WorkspaceFolder | undefined => store.folderFor(config.id);

  return [
    vscode.commands.registerCommand('remoteCodeCompanion.setUpRemote', async () => {
      const folder = await pickTargetFolder(store);
      if (!folder) {
        return;
      }
      const legacy = readLegacyProfiles(context);
      const result = await runSetupWizard({ folder, secrets, logger, legacy });
      if (!result) {
        return;
      }
      await store.write(folder, result.config);

      if (result.migratedFrom) {
        const backupDir = store.backupDirFor(result.config.id);
        const copied = backupDir
          ? await copyLegacyBackups(context.globalStorageUri.fsPath, result.config.id, backupDir, logger)
          : 0;
        const remaining = await removeLegacyProfile(context, result.config.id);
        void vscode.window.showInformationMessage(
          `Remote "${result.config.name}" is now attached to "${folder.name}"` +
            (copied > 0 ? `, with ${copied} backup(s) moved into .rcc/backups` : '') +
            (remaining > 0 ? `. ${remaining} old profile(s) left to migrate.` : '.')
        );
        return;
      }

      void vscode.window.showInformationMessage(
        `Remote "${result.config.name}" set up for "${folder.name}". Declaration written to .rcc/config.json — the password stays in the OS keychain.`
      );
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.disableRemote', async (arg?: unknown) => {
      const node = arg as { profileId?: string } | undefined;
      const config = node?.profileId ? store.get(node.profileId) : await pickRemote(store, 'Disable which remote?');
      if (!config) {
        return;
      }
      const folder = folderOf(config);
      if (!folder) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(
        `Disable the remote for "${folder.name}"?`,
        {
          modal: true,
          detail:
            `.rcc/config.json is deleted and the stored password is removed from the keychain.\n\n` +
            `Files already pulled into the folder and everything in .rcc/backups are kept.`
        },
        'Disable'
      );
      if (answer !== 'Disable') {
        return;
      }
      await manager.drop(config.id);
      await secrets.deleteAll(config.id);
      await store.deleteConfig(folder);
      void vscode.window.showInformationMessage(`Remote disabled for "${folder.name}".`);
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.exportRemoteConfig', async (arg?: unknown) => {
      const node = arg as { profileId?: string } | undefined;
      const config = node?.profileId ? store.get(node.profileId) : await pickRemote(store, 'Export which remote?');
      if (!config) {
        return;
      }
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file('rcc-remote.json'),
        filters: { JSON: ['json'] },
        title: 'Export remote config (the password is NOT included)'
      });
      if (!target) {
        return;
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(serializeConfig(config), 'utf8'));
      void vscode.window.showInformationMessage(
        'Remote config exported. The password is not in the file — it stays in the OS keychain.'
      );
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.importRemoteConfig', async () => {
      const folder = await pickTargetFolder(store);
      if (!folder) {
        return;
      }
      const picked = await vscode.window.showOpenDialog({
        filters: { JSON: ['json'] },
        canSelectMany: false,
        title: 'Import remote config'
      });
      if (!picked || picked.length === 0) {
        return;
      }
      let raw: string;
      try {
        raw = Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8');
      } catch (err) {
        void vscode.window.showErrorMessage(`Cannot read that file: ${String(err)}`);
        return;
      }
      const parsed = parseConfig(raw);
      if (!parsed.ok) {
        void vscode.window.showErrorMessage(`Not a usable remote config: ${parsed.error}`);
        return;
      }
      // A config imported twice would otherwise collide on id.
      const id = store.get(parsed.config.id) ? newProfileId() : parsed.config.id;
      await store.write(folder, configFromProfile({ ...parsed.config, id }, parsed.config));
      void vscode.window.showInformationMessage(
        `Remote imported into "${folder.name}". You will be asked for the password on first connect.`
      );
    }),

    /** Repairs the copied-project case surfaced by RemoteConfigStore.issues(). */
    vscode.commands.registerCommand('remoteCodeCompanion.regenerateRemoteId', async (arg?: unknown) => {
      const target = arg as { folder?: vscode.WorkspaceFolder; config?: RemoteConfig } | undefined;
      if (!target?.folder || !target.config) {
        return;
      }
      const fresh = { ...target.config, id: newProfileId() };
      await store.write(target.folder, fresh);
      void vscode.window.showInformationMessage(
        `"${target.folder.name}" now has its own remote id. Its password must be entered again on first connect.`
      );
    })
  ];
}
