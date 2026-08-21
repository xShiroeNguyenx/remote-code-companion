import * as fs from 'fs';
import * as vscode from 'vscode';
import { registerBackupCommands } from './backup/backup-commands';
import { BackupManager } from './backup/backup-manager';
import { config } from './config';
import { ConnectionManager } from './connection/connection-manager';
import { RemoteCredentials } from './connection/types';
import {
  CONFIG_GLOB,
  CONTEXT_HAS_REMOTE,
  DIFF_SCHEME,
  LOCAL_SAVE_NOTICE_KEY,
  SCHEME,
  TREE_VIEW_ID
} from './constants';
import { RccError } from './core/errors';
import { FileStateTracker } from './fs/file-state-tracker';
import { RemoteContentProvider } from './fs/remote-content-provider';
import { RemoteFsProvider } from './fs/remote-fs-provider';
import { log } from './log';
import { localTarget } from './mirror/local-target';
import { registerSyncCommands } from './mirror/sync-commands';
import { SyncEngine } from './mirror/sync-engine';
import { registerUploadCommands } from './mirror/upload-commands';
import { registerPreviewCommands } from './preview/preview-commands';
import { LocalDatabase } from './preview/mysql-server';
import { PreviewServers } from './preview/preview-server';
import { ProfileSecrets } from './profiles/profile-secrets';
import { registerRemoteCommands } from './profiles/remote-commands';
import { configPathOf, ConfigIssue, RemoteConfigStore } from './profiles/remote-config-store';
import { ServerProfile } from './profiles/types';
import { SettingsPanel } from './settings/settings-panel';
import { SavePipeline } from './save/save-pipeline';
import { RemoteTreeProvider } from './tree/remote-tree-provider';
import { registerTreeCommands } from './tree/tree-commands';
import { StatusBarManager } from './ui/status-bar';

let managerRef: ConnectionManager | undefined;
let previewsRef: PreviewServers | undefined;
let previewDatabaseRef: LocalDatabase | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  log.info('Remote Code Companion activating');

  const store = new RemoteConfigStore(log);
  const secrets = new ProfileSecrets(context.secrets);
  const statusBar = new StatusBarManager();
  const tracker = new FileStateTracker();
  // Backups live in the folder that owns the remote, resolved per save.
  const backups = new BackupManager((profileId) => store.backupDirFor(profileId), log, () => ({
    maxPerFile: config.backupMaxPerFile(),
    maxAgeDays: config.backupMaxAgeDays()
  }));

  const manager = new ConnectionManager({
    getProfile: (id) => store.get(id),
    getCredentials: (profile) => resolveCredentials(profile, secrets),
    logger: log,
    idleTimeoutMs: () => config.idleTimeoutMs(),
    onStateChange: (profileId, state) => {
      statusBar.onConnectionState(profileId, state);
      tree.refresh();
    },
    onBusyChange: (pendingTotal) => statusBar.onBusyChange(pendingTotal)
  });
  managerRef = manager;

  const pipeline = new SavePipeline({
    tracker,
    backups,
    logger: log,
    onUploaded: (fileName) => statusBar.flashUploaded(fileName),
    // The dialog's own "stop asking" checkbox: it writes the per-remote
    // override, so the choice lives with the folder that owns the server
    // rather than in a setting the user has to go looking for.
    onSuppressConfirm: (profileId) => suppressConfirm(profileId)
  });

  const fsProvider = new RemoteFsProvider({ profiles: store, manager, tracker, pipeline, backups, logger: log });
  const contentProvider = new RemoteContentProvider(store, manager, log);
  const tree = new RemoteTreeProvider(store, manager, log);

  const previews = new PreviewServers(log);
  const previewDatabase = new LocalDatabase(context.globalStorageUri.fsPath, log, () => config.mysqlBinDir());
  previewsRef = previews;
  previewDatabaseRef = previewDatabase;

  const engine = new SyncEngine({
    store,
    manager,
    tracker,
    pipeline,
    logger: log,
    onPendingChanged: () => refreshSyncContext()
  });

  /**
   * Which copy is on screen? A local file in a remote-enabled folder saves to
   * disk and waits for a push; an rcc:// document uploads on save. The status bar
   * must never leave that ambiguous.
   */
  const refreshSyncContext = (): void => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme === SCHEME) {
      const profileId = uri.authority;
      statusBar.setSyncContext({ kind: 'live', host: store.get(profileId)?.host });
      return;
    }
    const local = uri && uri.scheme === 'file' ? localTarget(store, uri) : undefined;
    if (local && engine.isTrackedOrInRoots(local.config, local.localRelPath)) {
      statusBar.setSyncContext({ kind: 'local', pending: engine.pendingCount(local.config.id) });
      return;
    }
    statusBar.setSyncContext({ kind: 'none' });
  };

  const applyRemoteState = async (): Promise<void> => {
    await vscode.commands.executeCommand('setContext', CONTEXT_HAS_REMOTE, store.hasAny());
    tree.refresh();
  };

  const reload = async (): Promise<void> => {
    const previous = new Set(store.all().map((c) => c.id));
    await store.reload();
    // Drop connections whose declaration changed or disappeared.
    for (const id of previous) {
      if (!store.get(id)) {
        await manager.drop(id);
        engine.invalidate(id);
      }
    }
    await applyRemoteState();
    reportIssues(store.issues());
  };

  /**
   * After a config change: the live session may now be wrong (different host,
   * port, credential or root), and cached sync state belongs to the old one.
   */
  const onRemoteConfigSaved = async (profileId: string): Promise<void> => {
    await manager.drop(profileId);
    engine.invalidate(profileId);
    await refreshPending();
  };

  /**
   * Turn off the upload confirmation for one remote, from the dialog itself.
   * It is a per-remote override in .rcc/config.json rather than a global
   * setting: "stop asking about this site" is not "stop asking about every site".
   */
  const suppressConfirm = async (profileId: string): Promise<void> => {
    const folder = store.folderFor(profileId);
    const current = store.get(profileId);
    if (!folder || !current) {
      return;
    }
    await store.write(folder, { ...current, confirmOnSave: false });
  };

  /** Recompute pending counts without touching the network. */
  const refreshPending = async (): Promise<void> => {
    for (const config of store.all()) {
      await engine.recomputePending(config);
    }
    refreshSyncContext();
  };

  const onLocalSave = async (doc: vscode.TextDocument): Promise<void> => {
    if (doc.uri.scheme !== 'file') {
      return;
    }
    const target = localTarget(store, doc.uri);
    if (!target || !engine.isTrackedOrInRoots(target.config, target.localRelPath)) {
      return;
    }
    await engine.notePending(target.config, target.localRelPath);
    refreshSyncContext();

    if (config.warnOnFirstLocalSave() && !context.globalState.get<boolean>(LOCAL_SAVE_NOTICE_KEY)) {
      await context.globalState.update(LOCAL_SAVE_NOTICE_KEY, true);
      void vscode.window
        .showInformationMessage(
          `Saved to disk — not to ${target.config.host}. This is your local copy; run "Push Changes" when you want it on the server.`,
          'Push Changes'
        )
        .then((answer) => {
          if (answer === 'Push Changes') {
            void vscode.commands.executeCommand('remoteCodeCompanion.push', { profileId: target.config.id });
          }
        });
    }
  };

  const watcher = vscode.workspace.createFileSystemWatcher(CONFIG_GLOB);

  context.subscriptions.push(
    statusBar,
    watcher,
    vscode.workspace.registerFileSystemProvider(SCHEME, fsProvider, { isCaseSensitive: true }),
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, contentProvider),
    vscode.window.createTreeView(TREE_VIEW_ID, { treeDataProvider: tree, showCollapseAll: true }),
    store.onDidChange(() => tree.refresh()),
    watcher.onDidCreate(() => void reload()),
    watcher.onDidChange(() => void reload()),
    watcher.onDidDelete(() => void reload()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void reload()),
    vscode.workspace.onDidSaveTextDocument((doc) => void onLocalSave(doc)),
    vscode.window.onDidChangeActiveTextEditor(() => refreshSyncContext()),
    ...registerRemoteCommands({ context, store, secrets, manager, logger: log }),
    ...registerTreeCommands({ store, manager, tree, logger: log, onConfigSaved: onRemoteConfigSaved }),
    ...registerSyncCommands({ store, engine, logger: log }),
    ...registerUploadCommands({ store, engine, logger: log }),
    ...registerPreviewCommands({
      store,
      servers: previews,
      database: previewDatabase,
      manager,
      getCredentials: (target) => resolveCredentials(target, secrets),
      logger: log,
      storageDir: context.globalStorageUri.fsPath
    }),
    vscode.commands.registerCommand('remoteCodeCompanion.openSettings', (arg?: { profileId?: string }) =>
      SettingsPanel.show(
        {
          store,
          secrets,
          logger: log,
          onConfigSaved: onRemoteConfigSaved
        },
        arg?.profileId
      )
    ),
    ...registerBackupCommands({ store, backups, logger: log })
  );

  await store.reload();
  await applyRemoteState();
  reportIssues(store.issues());
  await refreshPending();

  log.info(`Remote Code Companion activated (${store.all().length} remote-enabled folder(s))`);
}

export async function deactivate(): Promise<void> {
  // A preview server is a child process: leaving it behind would hold its port
  // after the window closes.
  await previewsRef?.stopAll();
  previewsRef = undefined;
  // A database left running would hold its port and its data directory lock.
  await previewDatabaseRef?.stop();
  previewDatabaseRef = undefined;
  await managerRef?.disconnectAll();
  managerRef = undefined;
}

/**
 * A broken or duplicated declaration is reported once per reload, with the one
 * action that fixes it — staying silent would leave the sidebar mysteriously empty.
 */
function reportIssues(issues: ConfigIssue[]): void {
  for (const issue of issues) {
    if (issue.duplicateOfFolder && issue.config) {
      void vscode.window
        .showWarningMessage(
          `"${issue.folder.name}": ${issue.error}`,
          'Generate New Id',
          'Ignore'
        )
        .then((answer) => {
          if (answer === 'Generate New Id') {
            void vscode.commands.executeCommand('remoteCodeCompanion.regenerateRemoteId', {
              folder: issue.folder,
              config: issue.config
            });
          }
        });
      continue;
    }
    void vscode.window
      .showWarningMessage(`"${issue.folder.name}" has an unusable .rcc/config.json: ${issue.error}`, 'Open File')
      .then((answer) => {
        if (answer === 'Open File') {
          void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(configPathOf(issue.folder)));
        }
      });
  }
}

/**
 * Credentials come from SecretStorage; when missing (fresh import, cleared
 * keychain) the user is prompted once and the answer is stored for next time.
 */
async function resolveCredentials(profile: ServerProfile, secrets: ProfileSecrets): Promise<RemoteCredentials> {
  if (profile.auth === 'privateKey') {
    if (!profile.privateKeyPath) {
      throw new RccError('ConnectionFailed', `Remote "${profile.name}" uses key auth but has no key path configured.`);
    }
    let privateKey: Buffer;
    try {
      privateKey = await fs.promises.readFile(profile.privateKeyPath);
    } catch (err) {
      throw new RccError('ConnectionFailed', `Cannot read private key ${profile.privateKeyPath}: ${String(err)}`);
    }
    const passphrase = await secrets.get(profile.id, 'passphrase');
    return { privateKey, passphrase: passphrase ?? undefined };
  }

  let password = await secrets.get(profile.id, 'password');
  if (password === undefined) {
    password = await vscode.window.showInputBox({
      prompt: `Password for ${profile.username}@${profile.host} (${profile.name})`,
      password: true,
      ignoreFocusOut: true
    });
    if (password === undefined) {
      throw new RccError('Cancelled', 'Connection cancelled — no password provided.');
    }
    await secrets.set(profile.id, 'password', password);
  }
  return { password };
}
