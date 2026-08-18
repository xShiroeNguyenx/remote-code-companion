export type RemoteFileType = 'file' | 'directory' | 'symlink';

/**
 * Where an mtime came from decides how much conflict detection trusts it:
 * - 'sftp'    — native SFTP stat, precise
 * - 'mdtm'    — FTP MDTM / MLSD modify fact, precise UTC
 * - 'listing' — parsed from a raw LIST line: minute granularity, unknown timezone
 * - 'none'    — the server told us nothing
 */
export type MtimeSource = 'sftp' | 'mdtm' | 'listing' | 'none';

export interface RemoteFileEntry {
  name: string;
  /** Absolute remote path. */
  path: string;
  type: RemoteFileType;
  size: number;
  mtimeMs?: number;
  mtimeSource: MtimeSource;
}

export interface ClientCapabilities {
  /** True when the protocol has a real stat call (SFTP). FTP derives stat from the parent listing. */
  nativeStat: boolean;
}

export interface RemoteCredentials {
  password?: string;
  privateKey?: Buffer;
  passphrase?: string;
}

/**
 * Raw protocol operations. No queueing, no caching, no reconnection —
 * ManagedConnection adds all of that on top.
 */
export interface RemoteClient {
  readonly capabilities: ClientCapabilities;
  connect(creds: RemoteCredentials): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  list(dirPath: string): Promise<RemoteFileEntry[]>;
  /** SFTP only. */
  stat?(remotePath: string): Promise<RemoteFileEntry>;
  /** FTP only (MDTM). Throws when the server does not support it. */
  lastMod?(remotePath: string): Promise<number>;
  readFile(remotePath: string): Promise<Buffer>;
  writeFile(remotePath: string, data: Buffer): Promise<void>;
  remove(remotePath: string, type: RemoteFileType): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(remotePath: string): Promise<void>;
  noop(): Promise<void>;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';
