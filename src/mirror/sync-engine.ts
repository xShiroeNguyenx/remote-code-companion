import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { config as settings } from '../config';
import { ConnectionManager, ManagedConnection } from '../connection/connection-manager';
import { RemoteFileEntry } from '../connection/types';
import { isConnectionFailure, isDataConnectionError, RccError } from '../core/errors';
import { matchesAnyGlob } from '../core/glob';
import { dirnameRemote } from '../core/remote-path';
import { formatError, Logger } from '../core/logger';
import { FileStateTracker } from '../fs/file-state-tracker';
import { rccUri } from '../fs/uri';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { RemoteConfig } from '../profiles/types';
import { detectConflict } from '../save/conflict-detector';
import { SavePipeline } from '../save/save-pipeline';
import { classify } from './classify';
import {
  emptyManifest,
  localPathFor,
  localRelPathFor,
  manifestPathIn,
  parseManifest,
  remotePathFor,
  serializeManifest
} from './manifest';
import { CONFLICTED, FileStatus, PUSHABLE, SideRemote, SyncEntry, SyncManifest } from './types';

export interface SyncEngineDeps {
  store: RemoteConfigStore;
  manager: ConnectionManager;
  tracker: FileStateTracker;
  logger: Logger;
  /**
   * The pipeline every push writes through. Optional only so a test can wire a
   * narrower stack; when present, a push can tell the confirmation dialog why
   * it is running instead of leaving it to guess.
   */
  pipeline?: SavePipeline;
  /** Fired when the pending count may have changed. */
  onPendingChanged?(profileId: string, pending: number): void;
}

export interface PushOptions {
  /**
   * Push a file the sync state calls conflicted. Only ever set from an action
   * where the user named the file themselves — the dialog then carries the
   * warning, so the decision is still theirs, just not a separate question.
   */
  force?: boolean;
  /** Shown in the confirmation: "Push · 2 of 7", "Right-click upload". */
  origin?: string;
  /** The user already confirmed this exact list; do not ask per file. */
  preConfirmed?: boolean;
}

export interface PullCandidate {
  remotePath: string;
  localRelPath: string;
  entry: RemoteFileEntry;
  /** Local file exists and is not tracked — pulling would overwrite unknown work. */
  overwritesUntracked: boolean;
  /** Local file is tracked but edited since the last sync — pulling would discard the edit. */
  overwritesLocalEdit: boolean;
  /**
   * Local copy already matches the baseline and the server has not moved, so
   * there is nothing to download. This makes a pull resumable: shared hosts drop
   * long transfers, and the retry should only fetch what is still missing.
   */
  alreadyCurrent: boolean;
}

export interface PullScan {
  candidates: PullCandidate[];
  skipped: { reason: string; items: string[] }[];
}

export interface PullResult {
  pulled: string[];
  bytes: number;
  skipped: { reason: string; items: string[] }[];
  /** Set when the pull stopped early because the connection died. */
  aborted?: string;
  /** Files that were still queued when it stopped. */
  remaining?: number;
}

export type PushOutcome = 'pushed' | 'cancelled' | 'failed' | 'skipped';

export interface PushResult {
  outcomes: { remotePath: string; outcome: PushOutcome; detail?: string }[];
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POSIX dirname for manifest-relative paths; '' for a file at the folder root. */
function posixDirname(relPath: string): string {
  const cut = relPath.lastIndexOf('/');
  return cut === -1 ? '' : relPath.slice(0, cut);
}

/**
 * Owns the baseline: pull writes it, push advances it, and everything else only
 * reads it. The rule that keeps production safe is that a baseline advances
 * *only* after a write the pipeline reported as verified — never on intent.
 */
export class SyncEngine {
  private readonly manifests = new Map<string, SyncManifest>();
  private readonly pending = new Map<string, Set<string>>();

  constructor(private readonly deps: SyncEngineDeps) {}

  // ------------------------------------------------------------- manifest I/O

  private folderPath(config: RemoteConfig): string | undefined {
    return this.deps.store.folderFor(config.id)?.uri.fsPath;
  }

  async manifest(config: RemoteConfig): Promise<SyncManifest> {
    const cached = this.manifests.get(config.id);
    if (cached && cached.remoteRoot === config.remoteRoot) {
      return cached;
    }
    const folder = this.folderPath(config);
    if (!folder) {
      return emptyManifest(config.remoteRoot);
    }
    let manifest: SyncManifest;
    try {
      const raw = await fs.promises.readFile(manifestPathIn(folder), 'utf8');
      const loaded = parseManifest(raw, config.remoteRoot);
      manifest = loaded.manifest;
      if (loaded.reset) {
        // Baselines that no longer describe this root are worse than none: they
        // would make "who changed it?" answerable but wrong.
        this.deps.logger.warn(`[${config.name}] sync baseline discarded — ${loaded.resetReason}`);
        void vscode.window.showWarningMessage(
          `Sync history for "${config.name}" was reset: ${loaded.resetReason}. Pull again to re-establish it.`
        );
      }
    } catch {
      manifest = emptyManifest(config.remoteRoot);
    }
    this.manifests.set(config.id, manifest);
    return manifest;
  }

  private async saveManifest(config: RemoteConfig, manifest: SyncManifest): Promise<void> {
    const folder = this.folderPath(config);
    if (!folder) {
      return;
    }
    const target = manifestPathIn(folder);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    await fs.promises.writeFile(tmp, serializeManifest(manifest), 'utf8');
    await fs.promises.rename(tmp, target);
    this.manifests.set(config.id, manifest);
  }

  // --------------------------------------------------------------- local side

  private async readLocal(config: RemoteConfig, localRelPath: string): Promise<Buffer | undefined> {
    const folder = this.folderPath(config);
    if (!folder) {
      return undefined;
    }
    try {
      return await fs.promises.readFile(localPathFor(folder, localRelPath));
    } catch {
      return undefined;
    }
  }

  isExcluded(config: RemoteConfig, remotePath: string): boolean {
    const rel = localRelPathFor(config.remoteRoot, remotePath);
    return rel === undefined || matchesAnyGlob(rel, config.excludes);
  }

  /**
   * Directories we consider under management: the declared roots, plus the
   * parent of every tracked file. Deriving it from the manifest too means a pull
   * done without updating `roots` still notices new files beside the ones it
   * fetched — the scope follows the data, not a field someone must remember to set.
   */
  private managedDirs(config: RemoteConfig, manifest: SyncManifest): string[] {
    const dirs = new Set<string>();
    for (const root of config.roots) {
      const rel = localRelPathFor(config.remoteRoot, root);
      if (rel !== undefined) {
        dirs.add(rel);
      }
    }
    for (const entry of Object.values(manifest.entries)) {
      const dir = posixDirname(entry.localRelPath);
      dirs.add(dir);
    }
    // Drop any directory already covered by an ancestor in the set.
    const sorted = [...dirs].sort((a, b) => a.length - b.length);
    const roots: string[] = [];
    for (const dir of sorted) {
      if (!roots.some((kept) => kept === dir || (kept === '' ? true : dir.startsWith(kept + '/')))) {
        roots.push(dir);
      }
    }
    return roots;
  }

  /** Local files under the managed directories that the manifest does not know about. */
  private async untrackedLocalFiles(config: RemoteConfig, manifest: SyncManifest): Promise<string[]> {
    const folder = this.folderPath(config);
    if (!folder) {
      return [];
    }
    const known = new Set(Object.values(manifest.entries).map((e) => e.localRelPath));
    const found: string[] = [];

    const walk = async (relDir: string): Promise<void> => {
      const abs = localPathFor(folder, relDir);
      let names: fs.Dirent[];
      try {
        names = await fs.promises.readdir(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of names) {
        const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
        if (rel === '.rcc' || matchesAnyGlob(rel, config.excludes)) {
          continue;
        }
        if (dirent.isDirectory()) {
          await walk(rel);
        } else if (dirent.isFile() && !known.has(rel)) {
          found.push(rel);
        }
      }
    };

    for (const dir of this.managedDirs(config, manifest)) {
      await walk(dir);
    }
    return found;
  }

  // -------------------------------------------------------------- remote side

  private async statRemote(conn: ManagedConnection, remotePath: string): Promise<RemoteFileEntry | undefined> {
    try {
      return await conn.stat(remotePath);
    } catch (err) {
      if (err instanceof RccError && err.code === 'FileNotFound') {
        return undefined;
      }
      const message = formatError(err).toLowerCase();
      if (message.includes('no such file') || message.startsWith('550')) {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Should we spend a download to hash the server copy? Only when the timestamp
   * cannot settle it *and* the answer matters — i.e. the file also changed
   * locally, so a wrong verdict would either hide a conflict or invent one.
   */
  private needsRemoteHash(entry: SyncEntry, remote: RemoteFileEntry | undefined, localChanged: boolean): boolean {
    const mode = settings.verifyByHash();
    if (mode === 'never' || !remote) {
      return false;
    }
    if (mode === 'always') {
      return true;
    }
    const weak = (source: string): boolean => source === 'listing' || source === 'none';
    return localChanged && (weak(entry.baseMtimeSource) || weak(remote.mtimeSource));
  }

  // ------------------------------------------------------------------- status

  /** One tracked file: the full 3-way comparison against its baseline. */
  private async statusOfTracked(
    conn: ManagedConnection,
    config: RemoteConfig,
    entry: SyncEntry
  ): Promise<FileStatus> {
    const localBytes = await this.readLocal(config, entry.localRelPath);
    const localSha = localBytes ? sha256(localBytes) : undefined;
    const localChanged = localSha !== undefined && localSha !== entry.baseSha256;
    const remoteEntry = await this.statRemote(conn, entry.remotePath);

    const remote: SideRemote = {
      exists: remoteEntry !== undefined,
      size: remoteEntry?.size,
      mtimeMs: remoteEntry?.mtimeMs,
      mtimeSource: remoteEntry?.mtimeSource
    };
    if (this.needsRemoteHash(entry, remoteEntry, localChanged)) {
      try {
        remote.sha256 = sha256(await conn.readFile(entry.remotePath));
      } catch (err) {
        this.deps.logger.warn(`hashing ${entry.remotePath} failed: ${formatError(err)}`);
      }
    }

    const result = classify(
      {
        sha256: entry.baseSha256,
        size: entry.baseSize,
        mtimeMs: entry.baseRemoteMtimeMs,
        mtimeSource: entry.baseMtimeSource
      },
      { exists: localBytes !== undefined, sha256: localSha },
      remote
    );
    return { ...result, remotePath: entry.remotePath, localRelPath: entry.localRelPath };
  }

  /** No baseline, so only "does it already exist remotely?" matters. */
  private async statusOfUntracked(
    conn: ManagedConnection,
    config: RemoteConfig,
    localRelPath: string
  ): Promise<FileStatus> {
    const target = remotePathFor(config.remoteRoot, localRelPath);
    const localBytes = await this.readLocal(config, localRelPath);
    const remoteEntry = await this.statRemote(conn, target);
    const result = classify(undefined, { exists: localBytes !== undefined }, { exists: remoteEntry !== undefined });
    return { ...result, remotePath: target, localRelPath };
  }

  async status(config: RemoteConfig): Promise<FileStatus[]> {
    const manifest = await this.manifest(config);
    const conn = this.deps.manager.getConnection(config.id);
    const out: FileStatus[] = [];

    for (const entry of Object.values(manifest.entries)) {
      out.push(await this.statusOfTracked(conn, config, entry));
    }
    for (const rel of await this.untrackedLocalFiles(config, manifest)) {
      out.push(await this.statusOfUntracked(conn, config, rel));
    }

    await this.recomputePending(config, out);
    return out;
  }

  /**
   * The state of named files only — one stat each, nothing else scanned. This is
   * what "upload this file" needs: the user already knows which file they
   * changed, and a full status pass costs a round trip per tracked file, which
   * on a mirrored theme is hundreds of them.
   *
   * The pending count is deliberately left alone: it describes the whole remote,
   * and a partial answer must not be allowed to overwrite it.
   */
  async statusOfPaths(config: RemoteConfig, localRelPaths: string[]): Promise<FileStatus[]> {
    const manifest = await this.manifest(config);
    const conn = this.deps.manager.getConnection(config.id);
    const byRel = new Map<string, SyncEntry>();
    for (const entry of Object.values(manifest.entries)) {
      byRel.set(entry.localRelPath, entry);
    }

    const out: FileStatus[] = [];
    for (const rel of localRelPaths) {
      const entry = byRel.get(rel);
      out.push(
        entry ? await this.statusOfTracked(conn, config, entry) : await this.statusOfUntracked(conn, config, rel)
      );
    }
    return out;
  }

  /**
   * Every file under one local directory, tracked or not — the candidate list
   * for "upload this folder". Unlike `status()` this does not care whether the
   * directory is a declared root: the user pointed at it, which is the same
   * kind of instruction.
   */
  async statusUnder(config: RemoteConfig, localRelDir: string): Promise<FileStatus[]> {
    const manifest = await this.manifest(config);
    const prefix = localRelDir ? localRelDir.replace(/\/+$/, '') + '/' : '';
    const paths = new Set<string>();
    for (const entry of Object.values(manifest.entries)) {
      if (!prefix || entry.localRelPath.startsWith(prefix)) {
        paths.add(entry.localRelPath);
      }
    }
    for (const rel of await this.localFilesUnder(config, localRelDir)) {
      paths.add(rel);
    }
    return this.statusOfPaths(config, [...paths].sort((a, b) => a.localeCompare(b)));
  }

  /** Local files under one directory, honouring the remote's exclude globs. */
  private async localFilesUnder(config: RemoteConfig, localRelDir: string): Promise<string[]> {
    const folder = this.folderPath(config);
    if (!folder) {
      return [];
    }
    const found: string[] = [];
    const walk = async (relDir: string): Promise<void> => {
      let names: fs.Dirent[];
      try {
        names = await fs.promises.readdir(localPathFor(folder, relDir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of names) {
        const rel = relDir ? `${relDir}/${dirent.name}` : dirent.name;
        if (rel === '.rcc' || matchesAnyGlob(rel, config.excludes)) {
          continue;
        }
        if (dirent.isDirectory()) {
          await walk(rel);
        } else if (dirent.isFile()) {
          found.push(rel);
        }
      }
    };
    await walk(localRelDir.replace(/\/+$/, ''));
    return found;
  }

  // ------------------------------------------------------------------ pending

  /** Local-only accounting: how many files are waiting to be pushed. No network. */
  async recomputePending(config: RemoteConfig, known?: FileStatus[]): Promise<number> {
    let set: Set<string>;
    if (known) {
      set = new Set(known.filter((s) => PUSHABLE.includes(s.state)).map((s) => s.localRelPath));
    } else {
      set = new Set<string>();
      const manifest = await this.manifest(config);
      for (const entry of Object.values(manifest.entries)) {
        const bytes = await this.readLocal(config, entry.localRelPath);
        if (bytes && sha256(bytes) !== entry.baseSha256) {
          set.add(entry.localRelPath);
        }
      }
      for (const rel of await this.untrackedLocalFiles(config, manifest)) {
        set.add(rel);
      }
    }
    this.pending.set(config.id, set);
    this.deps.onPendingChanged?.(config.id, set.size);
    return set.size;
  }

  /** Cheap single-file update, for the save hook. */
  async notePending(config: RemoteConfig, localRelPath: string): Promise<void> {
    const manifest = await this.manifest(config);
    const entry = Object.values(manifest.entries).find((e) => e.localRelPath === localRelPath);
    const bytes = await this.readLocal(config, localRelPath);
    const set = this.pending.get(config.id) ?? new Set<string>();
    const changed = bytes !== undefined && (!entry || sha256(bytes) !== entry.baseSha256);
    if (changed) {
      set.add(localRelPath);
    } else {
      set.delete(localRelPath);
    }
    this.pending.set(config.id, set);
    this.deps.onPendingChanged?.(config.id, set.size);
  }

  pendingCount(profileId: string): number {
    return this.pending.get(profileId)?.size ?? 0;
  }

  isTrackedOrInRoots(config: RemoteConfig, localRelPath: string): boolean {
    if (localRelPath.startsWith('.rcc/')) {
      return false;
    }
    const cached = this.manifests.get(config.id);
    if (cached && Object.values(cached.entries).some((e) => e.localRelPath === localRelPath)) {
      return true;
    }
    return config.roots.some((root) => {
      const rel = localRelPathFor(config.remoteRoot, root);
      return rel !== undefined && (rel === '' || localRelPath === rel || localRelPath.startsWith(rel + '/'));
    });
  }

  // --------------------------------------------------------------------- pull

  private async describeCandidate(
    conn: ManagedConnection,
    config: RemoteConfig,
    manifest: SyncManifest,
    entry: RemoteFileEntry,
    rel: string
  ): Promise<PullCandidate> {
    const tracked = manifest.entries[entry.path];
    const localBytes = await this.readLocal(config, rel);
    const localSha = localBytes ? sha256(localBytes) : undefined;
    const localMatchesBase = tracked !== undefined && localSha === tracked.baseSha256;

    // Skip the download only when the local copy is untouched *and* the server
    // has not moved. The comparison must be like-for-like: the baseline holds a
    // stat()-sourced timestamp (MDTM, exact UTC), while `entry` came from LIST
    // (minute precision, unknown timezone), so comparing those two would report
    // a change that never happened. One extra MDTM query is far cheaper than
    // re-downloading the file, and it is only spent on skip candidates.
    let serverStill = false;
    if (tracked && localMatchesBase) {
      const fresh = await this.statRemote(conn, entry.path);
      serverStill =
        fresh !== undefined &&
        !detectConflict(
          { size: tracked.baseSize, mtimeMs: tracked.baseRemoteMtimeMs, mtimeSource: tracked.baseMtimeSource },
          { size: fresh.size, mtimeMs: fresh.mtimeMs, mtimeSource: fresh.mtimeSource }
        ).conflict;
    }

    return {
      remotePath: entry.path,
      localRelPath: rel,
      entry,
      overwritesUntracked: localBytes !== undefined && !tracked,
      overwritesLocalEdit: localBytes !== undefined && tracked !== undefined && !localMatchesBase,
      alreadyCurrent: localMatchesBase && serverStill
    };
  }

  /**
   * Download one file, retrying a failed *data* connection on the same control
   * connection. Each FTP transfer needs a fresh passive port, and a shared host
   * will occasionally refuse one under load; the next attempt usually gets a
   * different port and succeeds.
   *
   * What this deliberately does NOT do is reconnect. Tearing down the control
   * connection and dialling again is what connection-flood protection reacts to,
   * and it turns a recoverable hiccup into a blocked IP.
   */
  private async fetchWithRetry(conn: ManagedConnection, remotePath: string, delayMs: number): Promise<Buffer> {
    const backoffs = [Math.max(500, delayMs * 5), Math.max(2000, delayMs * 20)];
    for (let attempt = 0; ; attempt++) {
      try {
        return await conn.readFile(remotePath);
      } catch (err) {
        if (attempt >= backoffs.length || !isDataConnectionError(err)) {
          throw err;
        }
        this.deps.logger.warn(
          `[data connection] ${remotePath} failed (${formatError(err)}) — waiting ${backoffs[attempt]}ms and asking for a new port`
        );
        await pause(backoffs[attempt]);
      }
    }
  }

  /** Walk the server subtree and work out what pulling would do — no writes yet. */
  async scanPull(config: RemoteConfig, remoteRootPath: string): Promise<PullScan> {
    const conn = this.deps.manager.getConnection(config.id);
    const manifest = await this.manifest(config);
    const maxBytes = Math.max(1, config.maxFileSizeKB) * 1024;
    const candidates: PullCandidate[] = [];
    const excluded: string[] = [];
    const tooBig: string[] = [];
    const symlinks: string[] = [];

    const walk = async (dirPath: string): Promise<void> => {
      for (const entry of await conn.list(dirPath)) {
        if (this.isExcluded(config, entry.path)) {
          excluded.push(entry.path);
          continue;
        }
        if (entry.type === 'directory') {
          await walk(entry.path);
          continue;
        }
        if (entry.type === 'symlink') {
          // Following links risks cycles and escaping the subtree.
          symlinks.push(entry.path);
          continue;
        }
        if (entry.size > maxBytes) {
          tooBig.push(`${entry.path} (${Math.round(entry.size / 1024)} KB)`);
          continue;
        }
        const rel = localRelPathFor(config.remoteRoot, entry.path);
        if (rel === undefined) {
          continue;
        }
        candidates.push(await this.describeCandidate(conn, config, manifest, entry, rel));
      }
    };

    const start = await this.statRemote(conn, remoteRootPath);
    if (!start) {
      throw new RccError('FileNotFound', `${remoteRootPath} does not exist on ${config.name}.`);
    }
    if (start.type === 'file') {
      const rel = localRelPathFor(config.remoteRoot, remoteRootPath);
      if (rel !== undefined && !this.isExcluded(config, remoteRootPath)) {
        candidates.push(
          await this.describeCandidate(conn, config, manifest, { ...start, path: remoteRootPath }, rel)
        );
      }
    } else {
      await walk(remoteRootPath);
    }

    const skipped = [
      { reason: 'excluded by pattern', items: excluded },
      { reason: `larger than ${config.maxFileSizeKB} KB`, items: tooBig },
      { reason: 'symlinks (not followed)', items: symlinks }
    ].filter((s) => s.items.length > 0);
    return { candidates, skipped };
  }

  /** Download the given candidates and advance their baselines. */
  async pull(
    config: RemoteConfig,
    scan: PullScan,
    accepted: PullCandidate[],
    progress?: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<PullResult> {
    const folder = this.folderPath(config);
    if (!folder) {
      throw new RccError('FileNotFound', `The folder for "${config.name}" is not open.`);
    }
    const conn = this.deps.manager.getConnection(config.id);
    const manifest = await this.manifest(config);
    const pulled: string[] = [];
    let bytes = 0;
    const failed: string[] = [];

    const alreadyCurrent: string[] = [];
    const delayMs = settings.pullDelayMs();
    let aborted: string | undefined;
    let remaining = 0;

    let done = 0;
    for (const candidate of accepted) {
      done++;
      if (candidate.alreadyCurrent) {
        alreadyCurrent.push(candidate.localRelPath);
        continue;
      }
      progress?.report({
        message: `${candidate.localRelPath} (${done}/${accepted.length})`,
        increment: 100 / Math.max(1, accepted.length)
      });
      if (pulled.length > 0 && delayMs > 0) {
        await pause(delayMs);
      }
      try {
        const data = await this.fetchWithRetry(conn, candidate.remotePath, delayMs);
        const target = localPathFor(folder, candidate.localRelPath);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, data);
        // The baseline timestamp must come from the same call `status()` will
        // make later. The scan's entry came from LIST (minute precision, unknown
        // timezone) while stat() refines with MDTM (exact UTC) — recording the
        // LIST value would make every pulled file look changed on the server forever.
        const after = await this.statRemote(conn, candidate.remotePath);
        manifest.entries[candidate.remotePath] = {
          remotePath: candidate.remotePath,
          localRelPath: candidate.localRelPath,
          baseSha256: sha256(data),
          baseSize: data.byteLength,
          baseRemoteMtimeMs: after?.mtimeMs ?? candidate.entry.mtimeMs,
          baseMtimeSource: after?.mtimeSource ?? candidate.entry.mtimeSource,
          pulledAt: Date.now()
        };
        pulled.push(candidate.localRelPath);
        bytes += data.byteLength;
      } catch (err) {
        this.deps.logger.error(`pulling ${candidate.remotePath} failed`, err);
        if (isConnectionFailure(err)) {
          // The connection is gone. Trying the rest would mean one timeout per
          // remaining file — a long hang instead of one clear message. Whatever
          // was written so far stays, and its baselines are saved below, so a
          // second pull resumes rather than starting over.
          aborted = formatError(err);
          remaining = accepted.length - done;
          break;
        }
        failed.push(`${candidate.localRelPath} (${formatError(err)})`);
      }
    }

    await this.saveManifest(config, manifest);
    await this.recomputePending(config);

    const skipped = [...scan.skipped];
    const declined = scan.candidates.filter((c) => !accepted.includes(c));
    if (declined.length > 0) {
      skipped.push({ reason: 'kept local version', items: declined.map((c) => c.localRelPath) });
    }
    if (alreadyCurrent.length > 0) {
      skipped.push({ reason: 'already up to date', items: alreadyCurrent });
    }
    if (failed.length > 0) {
      skipped.push({ reason: 'download failed', items: failed });
    }
    return { pulled, bytes, skipped, aborted, remaining: aborted ? remaining : undefined };
  }

  // --------------------------------------------------------------------- push

  /**
   * Push through the save pipeline by writing to the rcc:// URI, so conflict
   * check, backup, confirmation and verification all still apply. The baseline
   * moves only for files the pipeline completed.
   */
  async push(config: RemoteConfig, targets: FileStatus[], options?: PushOptions): Promise<PushResult> {
    const manifest = await this.manifest(config);
    const conn = this.deps.manager.getConnection(config.id);
    const folder = this.folderPath(config);
    const outcomes: PushResult['outcomes'] = [];

    for (const [index, target] of targets.entries()) {
      if (CONFLICTED.includes(target.state) && !options?.force) {
        outcomes.push({ remotePath: target.remotePath, outcome: 'skipped', detail: 'conflicted — resolve first' });
        continue;
      }
      const bytes = await this.readLocal(config, target.localRelPath);
      if (!bytes) {
        outcomes.push({ remotePath: target.remotePath, outcome: 'failed', detail: 'local file disappeared' });
        continue;
      }

      const uri = rccUri(config.id, target.remotePath);
      const existing = manifest.entries[target.remotePath];

      // Tell the pipeline what this push already knows. Without it the dialog
      // would either repeat a question the caller just asked, or stay silent
      // about a risk only the sync state can see.
      if (this.deps.pipeline) {
        this.deps.pipeline.declareIntent(uri, {
          origin: options?.origin
            ? targets.length > 1
              ? `${options.origin} · ${index + 1} of ${targets.length}`
              : options.origin
            : undefined,
          confirmed: options?.preConfirmed === true,
          warnings: this.pushWarnings(target),
          localUri: folder ? vscode.Uri.file(localPathFor(folder, target.localRelPath)) : undefined
        });
      }

      // A file created locally may sit in a directory that does not exist on the
      // server yet — a new plugin folder, for instance. Neither FTP nor SFTP
      // creates parents on write, so the upload would fail with a bare "no such
      // file". Both clients make mkdir recursive and idempotent, so asking for it
      // costs one command and is safe when the directory is already there.
      if (!existing) {
        const parent = dirnameRemote(target.remotePath);
        try {
          await conn.mkdir(parent);
        } catch (err) {
          // Not fatal on its own: the directory may exist and the server may still
          // report an error for the attempt. Let the upload be the real verdict.
          this.deps.logger.debug(`[push] mkdir ${parent}: ${formatError(err)}`);
        }
      }
      if (existing) {
        // Seed the pipeline's baseline so it can still catch a server-side change
        // that happened between our status check and this upload.
        this.deps.tracker.capture(uri.toString(), {
          name: target.localRelPath,
          path: target.remotePath,
          type: 'file',
          size: existing.baseSize,
          mtimeMs: existing.baseRemoteMtimeMs,
          mtimeSource: existing.baseMtimeSource
        });
      }

      try {
        await vscode.workspace.fs.writeFile(uri, bytes);
      } catch (err) {
        const message = formatError(err);
        const cancelled = /cancelled/i.test(message);
        // The write may have failed before the pipeline read the intent.
        this.deps.pipeline?.dropIntent(uri);
        outcomes.push({
          remotePath: target.remotePath,
          outcome: cancelled ? 'cancelled' : 'failed',
          detail: message
        });
        continue;
      }

      // Verified by the pipeline: now the baseline may advance.
      const after = await this.statRemote(conn, target.remotePath);
      manifest.entries[target.remotePath] = {
        remotePath: target.remotePath,
        localRelPath: target.localRelPath,
        baseSha256: sha256(bytes),
        baseSize: bytes.byteLength,
        baseRemoteMtimeMs: after?.mtimeMs,
        baseMtimeSource: after?.mtimeSource ?? 'none',
        pulledAt: existing?.pulledAt ?? Date.now(),
        pushedAt: Date.now()
      };
      outcomes.push({ remotePath: target.remotePath, outcome: 'pushed' });
    }

    await this.saveManifest(config, manifest);
    await this.recomputePending(config);
    return { outcomes };
  }

  /**
   * What the confirmation must say about this file beyond the pipeline's own
   * checks. Only states that a plain push would have refused produce a warning:
   * the point is that a forced upload still tells the truth about what it
   * overwrites.
   */
  private pushWarnings(target: FileStatus): string[] {
    switch (target.state) {
      case 'createdBoth':
        return [
          'A file already exists at this path on the server and was never pulled, so there is no baseline to compare — uploading replaces it.'
        ];
      case 'bothChanged':
        // With conflictCheck on, the pipeline states this itself from the
        // baseline; saying it twice in one dialog reads as a bug.
        return settings.conflictCheck() ? [] : [`Conflicted: ${target.reason}. Uploading discards the server version.`];
      case 'remoteMissing':
        return ['This file was deleted on the server since the last sync — uploading re-creates it.'];
      default:
        return [];
    }
  }

  /** Take the server version for one file, discarding the local copy. */
  async takeServer(config: RemoteConfig, status: FileStatus): Promise<void> {
    const scan = await this.scanPull(config, status.remotePath);
    await this.pull(config, scan, scan.candidates);
  }

  /** Forget a file: stop tracking it without touching either copy. */
  async forget(config: RemoteConfig, remotePath: string): Promise<void> {
    const manifest = await this.manifest(config);
    delete manifest.entries[remotePath];
    await this.saveManifest(config, manifest);
    await this.recomputePending(config);
  }

  invalidate(profileId: string): void {
    this.manifests.delete(profileId);
    this.pending.delete(profileId);
  }
}
