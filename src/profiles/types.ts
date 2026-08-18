export type Protocol = 'ftp' | 'ftps' | 'ftps-implicit' | 'sftp';
export type AuthMethod = 'password' | 'privateKey';

export interface ServerProfile {
  /** 8-char lowercase hex — must stay lowercase because vscode.Uri lowercases the URI authority. */
  id: string;
  name: string;
  protocol: Protocol;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  /** Local filesystem path to the private key (sftp only). The passphrase lives in SecretStorage. */
  privateKeyPath?: string;
  /** Absolute POSIX path used as the tree root / mount root. */
  remoteRoot: string;
  readOnly: boolean;
  /** Per-profile overrides; undefined = inherit the global setting. */
  confirmOnSave?: boolean;
  backupOnSave?: boolean;
  /** Escape hatch for shared hosts with self-signed FTPS certificates. Default true. */
  ftpSecureRejectUnauthorized?: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Contents of `<workspace folder>/.rcc/config.json` — a folder's remote
 * declaration. Extends ServerProfile so the connection layer can consume it
 * directly; the extra fields describe what Phase 2 syncs.
 */
export interface RemoteConfig extends ServerProfile {
  version: 1;
  /** Remote subtrees under sync management. */
  roots: string[];
  /** Globs never pulled, matched relative to remoteRoot. */
  excludes: string[];
  /** Files larger than this are skipped by a pull. */
  maxFileSizeKB: number;
}

/**
 * Phase 1 kept profiles in globalState. Retained only so setup can offer to
 * migrate them into a folder's config; nothing writes here any more.
 */
export const LEGACY_PROFILE_STATE_KEY = 'remoteCodeCompanion.profiles';

export interface LegacyProfileStoreShape {
  profiles: ServerProfile[];
}

export function defaultPort(protocol: Protocol): number {
  switch (protocol) {
    case 'sftp':
      return 22;
    case 'ftps-implicit':
      return 990;
    default:
      return 21;
  }
}

export function protocolLabel(protocol: Protocol): string {
  switch (protocol) {
    case 'ftp':
      return 'FTP';
    case 'ftps':
      return 'FTPS (explicit TLS)';
    case 'ftps-implicit':
      return 'FTPS (implicit TLS)';
    case 'sftp':
      return 'SFTP (SSH)';
  }
}
