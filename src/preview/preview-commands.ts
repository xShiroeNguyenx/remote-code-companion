import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { config as settings } from '../config';
import { ConnectionManager } from '../connection/connection-manager';
import { RemoteCredentials } from '../connection/types';
import { formatError, Logger } from '../core/logger';
import { joinRemote } from '../core/remote-path';
import { localPathFor, localRelPathFor } from '../mirror/manifest';
import { findPhp, PhpRuntime } from '../php/php-runtime';
import { pickRemote } from '../profiles/remote-commands';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { RemoteConfig } from '../profiles/types';
import { cloneDatabase } from './clone-database';
import { LocalDatabase } from './mysql-server';
import { findFreePort, PreviewServers } from './preview-server';
import { clearState, localDatabaseName, readState, writeState } from './preview-state';
import { findPreviewTargets, PreviewTarget } from './theme-detect';
import { ensureSite, PreviewDatabase, removeSite } from './wordpress-site';

export interface PreviewCommandDeps {
  store: RemoteConfigStore;
  servers: PreviewServers;
  database: LocalDatabase;
  manager: ConnectionManager;
  getCredentials(config: RemoteConfig): Promise<RemoteCredentials>;
  logger: Logger;
  /** Extension storage, where preview sites, the database and the cache live. */
  storageDir: string;
}

const FIRST_PORT = 8765;

/**
 * Turning "the AI changed the theme" into "I can see the theme" without asking the
 * user to install a stack. PHP is the only prerequisite for an empty preview; a
 * clone of production also needs a local MySQL/MariaDB.
 */
async function requirePhp(logger: Logger): Promise<PhpRuntime | undefined> {
  const runtime = await findPhp(settings.phpPath(), logger);
  if (runtime) {
    return runtime;
  }
  const answer = await vscode.window.showErrorMessage('No PHP found on this machine, so the local preview cannot run.', {
    modal: true,
    detail:
      'The preview needs a PHP command-line binary — nothing else: no Apache, no Docker.\n\n' +
      'Install PHP (or XAMPP, which includes it), or set remoteCodeCompanion.php.path to an existing php executable.\n\n' +
      'A broken php.ini does not matter: PHP is always run with -n, which ignores it.'
  }, 'Open Settings');
  if (answer === 'Open Settings') {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'remoteCodeCompanion.php.path');
  }
  return undefined;
}

/** Which theme to preview: derived from the synced subtrees, asked only if ambiguous. */
async function resolveTarget(config: RemoteConfig): Promise<PreviewTarget | undefined> {
  const targets = findPreviewTargets(config.roots);
  const themes = targets.filter((t) => t.kind === 'theme');
  if (themes.length === 1) {
    return themes[0];
  }
  if (themes.length === 0) {
    void vscode.window.showInformationMessage(
      'Nothing to preview yet — pull a theme first, for example wp-content/themes/<your-theme>.'
    );
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    themes.map((t) => ({ label: t.name, description: t.remotePath, target: t })),
    { title: 'Preview which theme?', ignoreFocusOut: true }
  );
  return pick?.target;
}

/** Local directory for a remote path, if it has been pulled. */
function localDirFor(
  store: RemoteConfigStore,
  config: RemoteConfig,
  remotePath: string
): string | undefined {
  const folder = store.folderFor(config.id);
  const rel = localRelPathFor(config.remoteRoot, remotePath);
  if (!folder || rel === undefined) {
    return undefined;
  }
  const dir = localPathFor(folder.uri.fsPath, rel);
  return fs.existsSync(dir) ? dir : undefined;
}

export function registerPreviewCommands(deps: PreviewCommandDeps): vscode.Disposable[] {
  const { store, servers, database, manager, getCredentials, logger, storageDir } = deps;

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 89);
  statusItem.command = 'remoteCodeCompanion.openPreview';

  const refreshStatus = (): void => {
    const running = servers.any();
    if (running.length === 0) {
      statusItem.hide();
      return;
    }
    const cloned = readState(storageDir, running[0].profileId).database !== undefined;
    statusItem.text = `$(browser) Preview :${running[0].port}${cloned ? ' · live data' : ''}`;
    statusItem.tooltip = `Local WordPress preview at ${running[0].url}${
      cloned ? '\nUsing a copy of the production database.' : '\nEmpty WordPress: pull production data to match the live site.'
    }\nClick to open, or run "Stop Local Preview".`;
    statusItem.show();
  };

  const start = async (config: RemoteConfig): Promise<void> => {
    const target = await resolveTarget(config);
    if (!target) {
      return;
    }
    const themeSourceDir = localDirFor(store, config, target.remotePath);
    if (!themeSourceDir) {
      void vscode.window.showInformationMessage(
        `${target.remotePath} is not on disk yet. Run "Pull from Server" for it first.`
      );
      return;
    }
    const runtime = await requirePhp(logger);
    if (!runtime) {
      return;
    }

    // Plugins are linked when they happen to be pulled; a theme that calls into a
    // plugin renders blank without them.
    const pluginsSourceDir = localDirFor(store, config, joinRemote(config.remoteRoot, 'wp-content/plugins'));

    const state = readState(storageDir, config.id);
    // Reuse the port of a running preview so the site URL stays stable.
    const existing = servers.get(config.id);
    const port = existing ? existing.port : await findFreePort(FIRST_PORT);

    try {
      const previewDb = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Local preview of ${target.name}`, cancellable: false },
        async (progress): Promise<PreviewDatabase | undefined> => {
          if (!state.database) {
            return undefined;
          }
          const server = await database.ensureRunning((m) => progress.report({ message: m }));
          return { name: state.database.name, port: server.port as number, tablePrefix: state.database.tablePrefix };
        }
      );

      const paths = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Local preview of ${target.name}`, cancellable: false },
        async (progress) =>
          ensureSite({
            runtime,
            storageDir,
            profileId: config.id,
            themeSourceDir,
            themeName: target.name,
            pluginsSourceDir,
            database: previewDb,
            port,
            logger,
            report: (message) => progress.report({ message })
          })
      );

      const preview = await servers.start(config.id, runtime, paths, port);
      refreshStatus();

      const open = 'Open in Browser';
      const actions = previewDb ? [open] : [open, 'Pull Production Data'];
      const summary = previewDb
        ? `Previewing "${target.name}" with a copy of production data at ${preview.url}.`
        : `Previewing "${target.name}" at ${preview.url} — empty WordPress, so it will not look like the live site yet.`;
      const answer = await vscode.window.showInformationMessage(summary, ...actions);
      if (answer === open) {
        await vscode.env.openExternal(vscode.Uri.parse(preview.url));
      } else if (answer === 'Pull Production Data') {
        await vscode.commands.executeCommand('remoteCodeCompanion.cloneProductionData', { profileId: config.id });
      }
    } catch (err) {
      logger.error('starting the local preview failed', err);
      void vscode.window.showErrorMessage(`Local preview failed: ${formatError(err)}`);
    }
  };

  const clone = async (config: RemoteConfig): Promise<void> => {
    if (!database.available()) {
      const answer = await vscode.window.showErrorMessage(
        'No MySQL or MariaDB found on this machine, so production data cannot be copied.',
        {
          modal: true,
          detail:
            'A copy of a WordPress database needs a real MySQL server locally. XAMPP includes MariaDB and is enough — the extension runs its own instance on a private port and never touches yours.\n\n' +
            'If one is installed elsewhere, set remoteCodeCompanion.mysql.binDir to the folder containing mysqld.'
        },
        'Open Settings'
      );
      if (answer === 'Open Settings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'remoteCodeCompanion.mysql.binDir');
      }
      return;
    }

    const proceed = await vscode.window.showInformationMessage(
      `Copy the database of "${config.name}" to this machine?`,
      {
        modal: true,
        detail:
          `The server is asked to dump its own database with mysqldump, the dump is downloaded, and the temporary file on the server is deleted.\n\n` +
          `Nothing is written to ${config.host}: the copy is read-only from production's point of view, and the local site is configured so it can never redirect to the live URL.\n\n` +
          `Media stays on the server — image URLs keep pointing at ${config.host}, so pages look right without downloading the uploads folder.`
      },
      'Copy Database'
    );
    if (proceed !== 'Copy Database') {
      return;
    }

    try {
      const credentials = await getCredentials(config);
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Copying data from ${config.host}`, cancellable: false },
        async (progress) => {
          const server = await database.ensureRunning((m) => progress.report({ message: m }));
          return cloneDatabase({
            config,
            credentials,
            connection: manager.getConnection(config.id),
            mysql: server,
            databaseName: localDatabaseName(config.id),
            workDir: path.join(storageDir, 'preview', 'dumps', config.id),
            logger,
            report: (message) => progress.report({ message })
          });
        }
      );

      writeState(storageDir, config.id, {
        database: { name: localDatabaseName(config.id), tablePrefix: result.database.tablePrefix },
        clonedAt: Date.now(),
        sourceDatabase: result.database.name
      });

      const startNow = 'Start Preview';
      const answer = await vscode.window.showInformationMessage(
        `Copied ${result.tables} table(s), ${Math.round(result.bytes / 1024)} KB, from ${result.database.name}.`,
        startNow
      );
      if (answer === startNow) {
        await servers.stop(config.id);
        await start(config);
      }
    } catch (err) {
      logger.error('copying the production database failed', err);
      const message = formatError(err);
      const detail = /mysqldump/i.test(message)
        ? '\n\nThe host may not allow mysqldump over SSH. In that case export the database from cPanel > phpMyAdmin and import it manually, or ask the host to enable shell access.'
        : '';
      void vscode.window.showErrorMessage(`Copying the database failed: ${message}${detail}`);
    }
  };

  return [
    statusItem,

    vscode.commands.registerCommand('remoteCodeCompanion.startPreview', async (arg?: unknown) => {
      const node = arg as { profileId?: string } | undefined;
      const config = node?.profileId ? store.get(node.profileId) : await pickRemote(store, 'Preview which remote?');
      if (config) {
        await start(config);
      }
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.cloneProductionData', async (arg?: unknown) => {
      const node = arg as { profileId?: string } | undefined;
      const config = node?.profileId
        ? store.get(node.profileId)
        : await pickRemote(store, 'Copy production data from which remote?');
      if (config) {
        await clone(config);
      }
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.openPreview', async () => {
      const running = servers.any();
      if (running.length === 0) {
        void vscode.window.showInformationMessage('No preview is running. Run "Start Local Preview" first.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(running[0].url));
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.stopPreview', async () => {
      if (servers.any().length === 0 && !database.isRunning()) {
        void vscode.window.showInformationMessage('No preview is running.');
        return;
      }
      await servers.stopAll();
      await database.stop();
      refreshStatus();
      void vscode.window.showInformationMessage('Local preview stopped.');
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.resetPreview', async (arg?: unknown) => {
      const node = arg as { profileId?: string } | undefined;
      const config = node?.profileId ? store.get(node.profileId) : await pickRemote(store, 'Reset which preview?');
      if (!config) {
        return;
      }
      const answer = await vscode.window.showWarningMessage(`Delete the local preview site for "${config.name}"?`, {
        modal: true,
        detail:
          'The throwaway WordPress install and the copied database are removed. Your theme and plugin files are untouched — they live in the workspace folder — and the next preview rebuilds from the cached download.'
      }, 'Delete');
      if (answer !== 'Delete') {
        return;
      }
      await servers.stop(config.id);
      const state = readState(storageDir, config.id);
      if (state.database && database.isRunning()) {
        const server = await database.ensureRunning(() => undefined);
        server.query(`DROP DATABASE IF EXISTS \`${state.database.name}\`;`);
      }
      clearState(storageDir, config.id);
      removeSite(storageDir, config.id);
      refreshStatus();
      void vscode.window.showInformationMessage('Preview site deleted.');
    })
  ];
}
