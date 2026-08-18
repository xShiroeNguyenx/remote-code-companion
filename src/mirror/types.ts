import { MtimeSource } from '../connection/types';

/**
 * What a file's baseline was the last time local and server agreed — the shared
 * ancestor that makes 3-way comparison possible. Without it we could only ask
 * "are they different?", never "who changed it?".
 */
export interface SyncEntry {
  /** Absolute remote path; the authoritative key. */
  remotePath: string;
  /** POSIX, relative to the workspace folder. */
  localRelPath: string;
  baseSha256: string;
  baseSize: number;
  baseRemoteMtimeMs?: number;
  baseMtimeSource: MtimeSource;
  pulledAt: number;
  pushedAt?: number;
}

export interface SyncManifest {
  version: 1;
  /** Recorded so a later remoteRoot change is detected instead of silently remapping paths. */
  remoteRoot: string;
  entries: Record<string, SyncEntry>;
}

export const MANIFEST_VERSION = 1;

/**
 * The nine outcomes of comparing base / local / remote. Everything the UI does
 * is a reaction to one of these, and `bothChanged` is never resolved automatically.
 */
export type SyncState =
  | 'inSync'
  | 'localChanged'
  | 'remoteChanged'
  | 'bothChanged'
  | 'localMissing'
  | 'remoteMissing'
  | 'bothMissing'
  | 'created'
  | 'createdBoth';

/** States that a push is allowed to act on. */
export const PUSHABLE: SyncState[] = ['localChanged', 'created'];

/** States a user must resolve by hand; a tool must not pick a winner. */
export const CONFLICTED: SyncState[] = ['bothChanged', 'createdBoth'];

export interface SideLocal {
  exists: boolean;
  sha256?: string;
}

export interface SideRemote {
  exists: boolean;
  size?: number;
  mtimeMs?: number;
  mtimeSource?: MtimeSource;
  /** Present only when the file was hashed (mtime was not trustworthy enough). */
  sha256?: string;
}

export interface SideBase {
  sha256: string;
  size: number;
  mtimeMs?: number;
  mtimeSource: MtimeSource;
}

export interface Classification {
  state: SyncState;
  reason: string;
  /** True when the remote verdict rests on size/mtime rather than a hash. */
  degraded: boolean;
}

export interface FileStatus extends Classification {
  remotePath: string;
  localRelPath: string;
}
