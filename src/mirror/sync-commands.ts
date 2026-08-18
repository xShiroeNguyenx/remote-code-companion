import * as vscode from 'vscode';
import { config as settings } from '../config';
import { formatError, Logger } from '../core/logger';
import { isPhpFile, LintProblem, lintPhpFiles } from '../php/php-lint';
import { findPhp } from '../php/php-runtime';
import { normalizeRemotePath } from '../core/remote-path';
import { remoteSnapshotUri } from '../fs/uri';
import { pickRemote } from '../profiles/remote-commands';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { RemoteConfig } from '../profiles/types';
import { localPathFor } from './manifest';
import { PullCandidate, SyncEngine } from './sync-engine';
import { CONFLICTED, FileStatus, PUSHABLE, SyncState } from './types';

export interface SyncCommandDeps {
  store: RemoteConfigStore;
  engine: SyncEngine;
  logger: Logger;
}

/** Newline inside a modal detail. */
const DIALOG_NEWLINE = `
`;

/** Above either threshold, a pull is worth confirming — see the dialog for why. */
const LARGE_PULL_FILES = 150;
const LARGE_PULL_BYTES = 5 * 1024 * 1024;

const STATE_LABEL: Record<SyncState, { icon: string; text: string }> = {
  inSync: { icon: 'check', text: 'in sync' },
  localChanged: { icon: 'arrow-up', text: 'edited locally — push' },
  remoteChanged: { icon: 'arrow-down', text: 'changed on server — pull' },
  bothChanged: { icon: 'warning', text: 'CONFLICT' },
  localMissing: { icon: 'trash', text: 'deleted locally' },
  remoteMissing: { icon: 'circle-slash', text: 'deleted on server' },
  bothMissing: { icon: 'dash', text: 'gone on both sides' },
  created: { icon: 'add', text: 'new local file — push' },
  createdBoth: { icon: 'warning', text: 'CONFLICT — exists on both sides' }
};

/**
 * A dropped passive data connection has a small set of likely causes, none of them
 * guessable from the raw message. Naming them saves a long debugging session —
 * especially the flood-protection one, which looks like a network fault but is the
 * host deliberately blocking the IP for a while.
 */
function abortAdvice(aborted: string): string {
  const message = aborted.toLowerCase();

  // Timing out while *opening* the command connection, on a host that answered
  // moments earlier, is the signature of flood protection: blocked packets are
  // dropped rather than refused, so the client sees a timeout, not a rejection.
  if (message.includes('control socket') || message.includes('could not connect')) {
    return [
      'The command connection itself timed out. On a host that was answering a moment ago, that usually means your IP is being blocked, not that the server is down:',
      '  1. Shared hosts (cPanel firewalls such as CSF/LFD) block an IP that opens many connections quickly. Blocks are temporary — typically 15-60 minutes. Waiting is the fix; pulling a smaller subtree and raising remoteCodeCompanion.sync.pullDelayMs avoids a repeat.',
      '  2. If the block persists, ask the host to whitelist your IP, or check cPanel for an IP Blocker entry.',
      '  3. SFTP moves every file over one connection instead of one per file, so it rarely trips this at all. Switch protocol in Settings if the host offers SSH.'
    ].join('\n');
  }

  if (message.includes('data connection') || message.includes('transfer strateg')) {
    return [
      'Every FTP transfer needs a new connection on a high port, and this one could not be opened:',
      '  1. The host is throttling or temporarily blocking your IP after a burst of transfers. Raising remoteCodeCompanion.sync.pullDelayMs makes the next pull gentler.',
      '  2. Your network, router or VPN blocks the outbound high ports that passive FTP needs.',
      '  3. SFTP avoids the problem entirely: it moves every file over the single connection it already has.'
    ].join('\n');
  }

  return '';
}

function statusItem(status: FileStatus): vscode.QuickPickItem & { status: FileStatus } {
  const label = STATE_LABEL[status.state];
  return {
    label: `$(${label.icon}) ${status.localRelPath}`,
    description: label.text + (status.degraded ? ' · weak evidence' : ''),
    detail: status.reason,
    status
  };
}

function localUri(store: RemoteConfigStore, config: RemoteConfig, localRelPath: string): vscode.Uri | undefined {
  const folder = store.folderFor(config.id);
  return folder ? vscode.Uri.file(localPathFor(folder.uri.fsPath, localRelPath)) : undefined;
}

async function diffLocalWithServer(
  store: RemoteConfigStore,
  config: RemoteConfig,
  status: FileStatus
): Promise<void> {
  const local = localUri(store, config, status.localRelPath);
  if (!local) {
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    remoteSnapshotUri(config.id, status.remotePath),
    local,
    `Server ↔ Local: ${status.localRelPath}`
  );
}

/**
 * Refuse to upload PHP that cannot be parsed. A syntax error does not degrade a
 * WordPress site, it blanks every page of it, so this is the one class of
 * mistake worth stopping a push over.
 *
 * Returns the files that may proceed. When PHP is missing the push continues:
 * a machine without PHP is a reason to skip the check, not to block work.
 */
async function gateOnPhpSyntax(
  store: RemoteConfigStore,
  config: RemoteConfig,
  targets: FileStatus[],
  logger: Logger
): Promise<FileStatus[] | undefined> {
  if (!settings.lintPhpBeforePush()) {
    return targets;
  }
  const phpTargets = targets.filter((t) => isPhpFile(t.localRelPath));
  if (phpTargets.length === 0) {
    return targets;
  }
  const folder = store.folderFor(config.id);
  if (!folder) {
    return targets;
  }
  const runtime = await findPhp(settings.phpPath(), logger);
  if (!runtime) {
    logger.warn(`[php] no PHP found on this machine — syntax check skipped for ${phpTargets.length} file(s)`);
    return targets;
  }

  const problems: LintProblem[] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking PHP syntax (${phpTargets.length} file(s))...` },
    () =>
      lintPhpFiles(
        runtime,
        phpTargets.map((t) => ({
          localPath: localPathFor(folder.uri.fsPath, t.localRelPath),
          label: t.localRelPath
        }))
      )
  );
  if (problems.length === 0) {
    return targets;
  }

  const broken = new Set(problems.map((p) => p.file));
  const rest = targets.filter((t) => !broken.has(t.localRelPath));
  const detail = problems
    .map((p) => `${p.file}${p.line ? ':' + p.line : ''} — ${p.message}`)
    .join(DIALOG_NEWLINE);

  const pushRest = `Push the other ${rest.length} file(s)`;
  const answer = await vscode.window.showErrorMessage(
    `${problems.length} file(s) have PHP syntax errors and were not uploaded.`,
    {
      modal: true,
      detail: [detail, 'A parse error makes every page of the site blank, so these are held back. Fix them and push again.'].join(
        DIALOG_NEWLINE + DIALOG_NEWLINE
      )
    },
    ...(rest.length > 0 ? [pushRest] : [])
  );
  for (const problem of problems) {
    logger.error(`[php] ${problem.file}${problem.line ? ':' + problem.line : ''} ${problem.message}`);
  }
  if (rest.length > 0 && answer === pushRest) {
    return rest;
  }
  return undefined;
}

export function registerSyncCommands(deps: SyncCommandDeps): vscode.Disposable[] {
  const { store, engine, logger } = deps;

  const withErrors = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (err) {
      logger.error('sync command failed', err);
      void vscode.window.showErrorMessage(formatError(err));
    }
  };

  const runStatus = async (config: RemoteConfig): Promise<FileStatus[]> =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Checking ${config.name}...` },
      () => engine.status(config)
    );

  return [
    vscode.commands.registerCommand('remoteCodeCompanion.pull', async (arg?: unknown) => {
      await withErrors(async () => {
        const node = arg as { profileId?: string; path?: string } | undefined;
        const config = node?.profileId ? store.get(node.profileId) : await pickRemote(store, 'Pull from which remote?');
        if (!config) {
          return;
        }
        const folder = store.folderFor(config.id);
        if (!folder) {
          return;
        }

        // Offer the roots already under sync, plus whatever the tree node was.
        const suggestions = [...new Set([...(node?.path ? [node.path] : []), ...config.roots])];
        let target: string | undefined;
        if (suggestions.length > 0) {
          const pick = await vscode.window.showQuickPick(
            [
              ...suggestions.map((p) => ({ label: p, value: p })),
              { label: '$(edit) Another path...', value: '' }
            ],
            { title: 'Pull which remote path?', ignoreFocusOut: true }
          );
          if (!pick) {
            return;
          }
          target = pick.value || undefined;
        }
        if (!target) {
          const typed = await vscode.window.showInputBox({
            title: `Pull from ${config.name}`,
            prompt: 'Remote path to pull (its files land in this folder, mirroring the server)',
            value: config.remoteRoot,
            ignoreFocusOut: true,
            validateInput: (v) => (v.trim() ? undefined : 'A path is required')
          });
          if (typed === undefined) {
            return;
          }
          target = normalizeRemotePath(typed);
        }

        const scan = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Scanning ${target} on ${config.name}...` },
          () => engine.scanPull(config, target as string)
        );
        if (scan.candidates.length === 0) {
          void vscode.window.showInformationMessage(
            `Nothing to pull from ${target} — everything there is excluded or too large.`
          );
          return;
        }

        // Shared hosting caps how long a single FTP session survives, and every
        // file costs a transfer plus a timestamp query on one serialized
        // connection. A big pull is worth a second look before it starts.
        const toFetch = scan.candidates.filter((c) => !c.alreadyCurrent);
        const bytes = toFetch.reduce((sum, c) => sum + c.entry.size, 0);
        if (toFetch.length > LARGE_PULL_FILES || bytes > LARGE_PULL_BYTES) {
          const answer = await vscode.window.showWarningMessage(
            `Pull ${toFetch.length} files (${Math.round(bytes / 1024)} KB) from ${target}?`,
            {
              modal: true,
              detail:
                `Shared hosts often drop a session this long, and the transfer runs over a single connection.\n\n` +
                `Pulling one theme or plugin at a time is usually faster and far more reliable — ` +
                `for example ${target.replace(/\/$/, '')}/<the-theme-you-work-on>.\n\n` +
                `If it does get cut off, running Pull again resumes: files already up to date are not re-downloaded.`
            },
            'Pull Anyway'
          );
          if (answer !== 'Pull Anyway') {
            return;
          }
        }

        // Anything that would overwrite local work needs an explicit decision.
        const risky = scan.candidates.filter((c) => c.overwritesUntracked || c.overwritesLocalEdit);
        let accepted: PullCandidate[] = scan.candidates;
        if (risky.length > 0) {
          const edits = risky.filter((c) => c.overwritesLocalEdit).length;
          const untracked = risky.length - edits;
          const answer = await vscode.window.showWarningMessage(
            `Pulling ${scan.candidates.length} file(s) would overwrite ${risky.length} local file(s).`,
            {
              modal: true,
              detail:
                [
                  edits > 0 ? `${edits} have local edits that were never pushed.` : undefined,
                  untracked > 0 ? `${untracked} exist locally but were never pulled from this server.` : undefined,
                  '',
                  'Overwriting discards those local versions.'
                ]
                  .filter((line) => line !== undefined)
                  .join('\n')
            },
            'Overwrite All',
            'Keep Local Versions'
          );
          if (!answer) {
            return;
          }
          if (answer === 'Keep Local Versions') {
            accepted = scan.candidates.filter((c) => !c.overwritesUntracked && !c.overwritesLocalEdit);
          }
        }

        const result = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Pulling from ${config.name}`, cancellable: false },
          (progress) => engine.pull(config, scan, accepted, progress)
        );

        // Remember the subtree so status and pending counts cover it from now on.
        const root = normalizeRemotePath(target);
        if (!config.roots.includes(root)) {
          await store.write(folder, { ...config, roots: [...config.roots, root] });
        }

        const notes = result.skipped.map((s) => `${s.items.length} ${s.reason}`).join(', ');
        const summary =
          `Pulled ${result.pulled.length} file(s), ${Math.round(result.bytes / 1024)} KB, into "${folder.name}".` +
          (notes ? ` Skipped: ${notes}.` : '');

        if (result.aborted) {
          // Say plainly that the pull is incomplete: reporting it as a success
          // would leave the folder looking like a full copy of the subtree.
          const retry = await vscode.window.showWarningMessage(
            `Pull stopped early — the connection to ${config.host} dropped with ${result.remaining ?? 0} file(s) left.`,
            {
              modal: true,
              detail: [
                result.aborted,
                abortAdvice(result.aborted),
                summary,
                'Running Pull again continues where it stopped; files already up to date are skipped.'
              ]
                .filter(Boolean)
                .join('\n\n')
            },
            'Pull Again'
          );
          if (retry === 'Pull Again') {
            await vscode.commands.executeCommand('remoteCodeCompanion.pull', { profileId: config.id, path: target });
          }
          return;
        }

        void vscode.window.showInformationMessage(summary);
      });
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.push', async (arg?: unknown) => {
      await withErrors(async () => {
        const node = arg as { profileId?: string } | undefined;
        const config = node?.profileId ? store.get(node.profileId) : await pickRemote(store, 'Push to which remote?');
        if (!config) {
          return;
        }
        if (config.readOnly) {
          void vscode.window.showWarningMessage(`"${config.name}" is read-only — nothing is pushed.`);
          return;
        }

        const all = await runStatus(config);
        const pushable = all.filter((s) => PUSHABLE.includes(s.state));
        const conflicted = all.filter((s) => CONFLICTED.includes(s.state));

        if (pushable.length === 0) {
          const extra = conflicted.length > 0 ? ` ${conflicted.length} file(s) need conflict resolution first.` : '';
          void vscode.window.showInformationMessage(`Nothing to push to "${config.name}".${extra}`);
          return;
        }

        const picked = await vscode.window.showQuickPick(pushable.map(statusItem), {
          title: `Push to ${config.name} (${config.host})`,
          placeHolder:
            conflicted.length > 0
              ? `${conflicted.length} conflicted file(s) are excluded — resolve them separately`
              : 'Each file goes through backup, conflict check and confirmation',
          canPickMany: true,
          ignoreFocusOut: true
        });
        if (!picked || picked.length === 0) {
          return;
        }

        const allowed = await gateOnPhpSyntax(
          store,
          config,
          picked.map((p) => p.status),
          logger
        );
        if (!allowed || allowed.length === 0) {
          return;
        }

        const result = await engine.push(config, allowed);
        const pushed = result.outcomes.filter((o) => o.outcome === 'pushed').length;
        const cancelled = result.outcomes.filter((o) => o.outcome === 'cancelled').length;
        const failed = result.outcomes.filter((o) => o.outcome === 'failed');

        for (const failure of failed) {
          logger.error(`push failed for ${failure.remotePath}: ${failure.detail ?? ''}`);
        }
        const parts = [`${pushed} pushed`];
        if (cancelled > 0) {
          parts.push(`${cancelled} cancelled (still pending)`);
        }
        if (failed.length > 0) {
          parts.push(`${failed.length} failed — see the output log`);
        }
        const message = `Push to "${config.name}": ${parts.join(', ')}.`;
        if (failed.length > 0) {
          void vscode.window.showWarningMessage(message);
        } else {
          void vscode.window.showInformationMessage(message);
        }
      });
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.syncStatus', async (arg?: unknown) => {
      await withErrors(async () => {
        const node = arg as { profileId?: string } | undefined;
        const config = node?.profileId ? store.get(node.profileId) : await pickRemote(store, 'Status of which remote?');
        if (!config) {
          return;
        }
        const all = await runStatus(config);
        if (all.length === 0) {
          void vscode.window.showInformationMessage(
            `Nothing is synced for "${config.name}" yet — run "Pull from Server" first.`
          );
          return;
        }

        const counts = new Map<SyncState, number>();
        for (const status of all) {
          counts.set(status.state, (counts.get(status.state) ?? 0) + 1);
        }
        const summary = [...counts.entries()].map(([state, n]) => `${n} ${STATE_LABEL[state].text}`).join(' · ');

        const pick = await vscode.window.showQuickPick(
          all
            .slice()
            .sort((a, b) => a.state.localeCompare(b.state) || a.localRelPath.localeCompare(b.localRelPath))
            .map(statusItem),
          {
            title: `${config.name} — ${all.length} tracked file(s)`,
            placeHolder: summary + '  (new files on the server appear after a Pull)',
            matchOnDescription: true,
            ignoreFocusOut: true
          }
        );
        if (!pick) {
          return;
        }
        await fileActions(store, engine, config, pick.status);
      });
    }),

    vscode.commands.registerCommand('remoteCodeCompanion.resolveConflicts', async (arg?: unknown) => {
      await withErrors(async () => {
        const node = arg as { profileId?: string } | undefined;
        const config = node?.profileId
          ? store.get(node.profileId)
          : await pickRemote(store, 'Resolve conflicts on which remote?');
        if (!config) {
          return;
        }
        const conflicts = (await runStatus(config)).filter((s) => CONFLICTED.includes(s.state));
        if (conflicts.length === 0) {
          void vscode.window.showInformationMessage(`No conflicts on "${config.name}".`);
          return;
        }
        for (const conflict of conflicts) {
          const done = await resolveOne(store, engine, config, conflict);
          if (!done) {
            break; // user backed out; leave the rest untouched
          }
        }
      });
    })
  ];
}

/** Per-file actions from Sync Status. Nothing here resolves a conflict silently. */
async function fileActions(
  store: RemoteConfigStore,
  engine: SyncEngine,
  config: RemoteConfig,
  status: FileStatus
): Promise<void> {
  const actions: (vscode.QuickPickItem & { action: string })[] = [
    { label: '$(go-to-file) Open local file', action: 'open' },
    { label: '$(diff) Diff local against server', action: 'diff' }
  ];
  if (PUSHABLE.includes(status.state)) {
    actions.push({ label: '$(cloud-upload) Push this file', action: 'push' });
  }
  if (status.state === 'remoteChanged' || status.state === 'bothChanged') {
    actions.push({ label: '$(cloud-download) Take the server version', action: 'take' });
  }
  if (CONFLICTED.includes(status.state)) {
    actions.push({ label: '$(check) Keep mine (push over the server)', action: 'keep' });
  }
  actions.push({ label: '$(circle-slash) Stop tracking this file', action: 'forget' });

  const pick = await vscode.window.showQuickPick(actions, { title: status.localRelPath, ignoreFocusOut: true });
  if (!pick) {
    return;
  }
  switch (pick.action) {
    case 'open': {
      const uri = localUri(store, config, status.localRelPath);
      if (uri) {
        await vscode.commands.executeCommand('vscode.open', uri);
      }
      break;
    }
    case 'diff':
      await diffLocalWithServer(store, config, status);
      break;
    case 'push':
    case 'keep':
      await engine.push(config, [{ ...status, state: 'localChanged' }]);
      break;
    case 'take':
      await engine.takeServer(config, status);
      break;
    case 'forget':
      await engine.forget(config, status.remotePath);
      break;
  }
}

/** Returns false when the user cancels, so the caller stops iterating. */
async function resolveOne(
  store: RemoteConfigStore,
  engine: SyncEngine,
  config: RemoteConfig,
  status: FileStatus
): Promise<boolean> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(diff) Diff local against server', action: 'diff' },
      { label: '$(cloud-upload) Keep mine — push over the server', action: 'keep' },
      { label: '$(cloud-download) Take the server version — discard my copy', action: 'take' },
      { label: '$(debug-step-over) Skip this file for now', action: 'skip' }
    ],
    {
      title: `Conflict: ${status.localRelPath}`,
      placeHolder: status.reason,
      ignoreFocusOut: true
    }
  );
  if (!pick) {
    return false;
  }
  switch (pick.action) {
    case 'diff':
      await diffLocalWithServer(store, config, status);
      // Reviewing is not resolving: leave it conflicted and let the user come back.
      return true;
    case 'keep':
      await engine.push(config, [{ ...status, state: 'localChanged' }]);
      return true;
    case 'take':
      await engine.takeServer(config, status);
      return true;
    default:
      return true;
  }
}
