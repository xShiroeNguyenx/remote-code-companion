import * as path from 'path';
import { isWithinRemote, joinRemote, normalizeRemotePath } from '../core/remote-path';
import { MANIFEST_VERSION, SyncEntry, SyncManifest } from './types';

/**
 * Manifest storage and remote↔local path mapping, kept vscode-free and free of
 * I/O so the mapping rules are unit-testable.
 *
 * Pulled source mirrors the server under the workspace folder:
 *   remoteRoot /public_html + /public_html/wp-content/x.php  →  <folder>/wp-content/x.php
 */

export const RCC_DIR = '.rcc';
export const MANIFEST_FILE = 'manifest.json';

export function manifestPathIn(folderPath: string): string {
  return path.join(folderPath, RCC_DIR, MANIFEST_FILE);
}

export function emptyManifest(remoteRoot: string): SyncManifest {
  return { version: MANIFEST_VERSION, remoteRoot: normalizeRemotePath(remoteRoot), entries: {} };
}

/** POSIX-relative local path for a remote path, or undefined if it lies outside remoteRoot. */
export function localRelPathFor(remoteRoot: string, remotePath: string): string | undefined {
  const root = normalizeRemotePath(remoteRoot);
  const p = normalizeRemotePath(remotePath);
  if (!isWithinRemote(root, p)) {
    return undefined;
  }
  if (p === root) {
    return '';
  }
  const rel = root === '/' ? p.slice(1) : p.slice(root.length + 1);
  return rel;
}

export function remotePathFor(remoteRoot: string, localRelPath: string): string {
  return joinRemote(normalizeRemotePath(remoteRoot), localRelPath.split(/[\\/]+/).join('/'));
}

/** OS path of a mirrored file inside the workspace folder. */
export function localPathFor(folderPath: string, localRelPath: string): string {
  return path.join(folderPath, ...localRelPath.split('/').filter(Boolean));
}

export interface ManifestLoad {
  manifest: SyncManifest;
  /**
   * True when a manifest existed but described a different remoteRoot or version.
   * Its baselines cannot be trusted, so it is discarded rather than remapped.
   */
  reset: boolean;
  resetReason?: string;
}

export function parseManifest(raw: string, remoteRoot: string): ManifestLoad {
  const root = normalizeRemotePath(remoteRoot);
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { manifest: emptyManifest(root), reset: true, resetReason: 'manifest is not a JSON object' };
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return { manifest: emptyManifest(root), reset: true, resetReason: 'manifest is not valid JSON' };
  }

  if (parsed.version !== MANIFEST_VERSION) {
    return {
      manifest: emptyManifest(root),
      reset: true,
      resetReason: `manifest version ${String(parsed.version)} is not supported`
    };
  }
  const recordedRoot = normalizeRemotePath(typeof parsed.remoteRoot === 'string' ? parsed.remoteRoot : '/');
  if (recordedRoot !== root) {
    return {
      manifest: emptyManifest(root),
      reset: true,
      resetReason: `remote root changed from ${recordedRoot} to ${root}`
    };
  }

  const entries: Record<string, SyncEntry> = {};
  const rawEntries = parsed.entries;
  if (rawEntries && typeof rawEntries === 'object' && !Array.isArray(rawEntries)) {
    for (const [key, value] of Object.entries(rawEntries as Record<string, unknown>)) {
      const entry = parseEntry(key, value, root);
      if (entry) {
        entries[entry.remotePath] = entry;
      }
    }
  }
  return { manifest: { version: MANIFEST_VERSION, remoteRoot: root, entries }, reset: false };
}

function parseEntry(key: string, value: unknown, remoteRoot: string): SyncEntry | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const remotePath = normalizeRemotePath(typeof raw.remotePath === 'string' ? raw.remotePath : key);
  const rel = localRelPathFor(remoteRoot, remotePath);
  if (!rel) {
    return undefined; // outside the root: not ours to track
  }
  if (typeof raw.baseSha256 !== 'string' || typeof raw.baseSize !== 'number') {
    return undefined; // without a baseline the entry cannot support 3-way comparison
  }
  return {
    remotePath,
    localRelPath: typeof raw.localRelPath === 'string' && raw.localRelPath ? raw.localRelPath : rel,
    baseSha256: raw.baseSha256,
    baseSize: raw.baseSize,
    baseRemoteMtimeMs: typeof raw.baseRemoteMtimeMs === 'number' ? raw.baseRemoteMtimeMs : undefined,
    baseMtimeSource:
      raw.baseMtimeSource === 'sftp' || raw.baseMtimeSource === 'mdtm' || raw.baseMtimeSource === 'listing'
        ? raw.baseMtimeSource
        : 'none',
    pulledAt: typeof raw.pulledAt === 'number' ? raw.pulledAt : 0,
    pushedAt: typeof raw.pushedAt === 'number' ? raw.pushedAt : undefined
  };
}

export function serializeManifest(manifest: SyncManifest): string {
  // Sorted keys keep diffs of a committed manifest readable.
  const sorted: Record<string, SyncEntry> = {};
  for (const key of Object.keys(manifest.entries).sort((a, b) => a.localeCompare(b))) {
    sorted[key] = manifest.entries[key];
  }
  return JSON.stringify({ ...manifest, entries: sorted }, null, 2) + '\n';
}
