import { isValidProfileId } from '../core/rcc-uri';
import { normalizeRemotePath } from '../core/remote-path';
import { AuthMethod, Protocol, RemoteConfig, ServerProfile } from './types';

/**
 * Reading and writing `.rcc/config.json`, kept vscode-free so the parser can be
 * unit-tested directly. A config file is user-editable and may be committed, so
 * every field is validated on the way in rather than trusted.
 */

export const CONFIG_VERSION = 1;
export const RCC_DIR = '.rcc';
export const CONFIG_FILE = 'config.json';
export const DEFAULT_MAX_FILE_SIZE_KB = 1024;

const PROTOCOLS: Protocol[] = ['ftp', 'ftps', 'ftps-implicit', 'sftp'];

/**
 * Defaults aimed at WordPress on shared hosting: core is never edited, uploads
 * and caches are large and generated, and binary assets are not source.
 */
export const DEFAULT_EXCLUDES = [
  'wp-admin',
  'wp-includes',
  'wp-content/uploads',
  'wp-content/upgrade',
  'wp-content/cache',
  'wp-content/et-cache',
  'wp-content/ai1wm-backups',
  'wp-content/backups*',
  '**/node_modules',
  '**/.git',
  '**/.svn',
  '**/*.log',
  '**/error_log',
  '**/*.zip',
  '**/*.gz',
  '**/*.tar',
  '**/*.sql',
  '**/*.mo',
  '**/*.pot',
  '**/*.png',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.gif',
  '**/*.webp',
  '**/*.ico',
  '**/*.woff',
  '**/*.woff2',
  '**/*.ttf',
  '**/*.eot',
  '**/*.otf',
  '**/*.mp3',
  '**/*.mp4',
  '**/*.pdf',
  '**/*.psd'
];

/** Everything under .rcc stays out of git except the config itself. */
export const RCC_GITIGNORE = ['# Written by Remote Code Companion.', '*', '!.gitignore', '!config.json', ''].join('\n');

/** Wrap a freshly-built profile into a full config with Phase 2 defaults. */
export function configFromProfile(profile: ServerProfile, existing?: RemoteConfig): RemoteConfig {
  return {
    ...profile,
    version: CONFIG_VERSION,
    roots: existing?.roots ?? [],
    excludes: existing?.excludes ?? [...DEFAULT_EXCLUDES],
    maxFileSizeKB: existing?.maxFileSizeKB ?? DEFAULT_MAX_FILE_SIZE_KB
  };
}

export function serializeConfig(config: RemoteConfig): string {
  // Explicit key order so a hand-edited file stays readable and diffs stay small.
  const ordered = {
    version: CONFIG_VERSION,
    id: config.id,
    name: config.name,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth,
    ...(config.privateKeyPath ? { privateKeyPath: config.privateKeyPath } : {}),
    remoteRoot: config.remoteRoot,
    readOnly: config.readOnly,
    ...(config.confirmOnSave === undefined ? {} : { confirmOnSave: config.confirmOnSave }),
    ...(config.backupOnSave === undefined ? {} : { backupOnSave: config.backupOnSave }),
    ...(config.ftpSecureRejectUnauthorized === undefined
      ? {}
      : { ftpSecureRejectUnauthorized: config.ftpSecureRejectUnauthorized }),
    roots: config.roots,
    excludes: config.excludes,
    maxFileSizeKB: config.maxFileSizeKB,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt
  };
  return JSON.stringify(ordered, null, 2) + '\n';
}

export type ParseResult = { ok: true; config: RemoteConfig } | { ok: false; error: string };

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const items = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  return items.map((v) => v.trim());
}

/**
 * Parse a config file. A password found here is a mistake worth refusing: the
 * file may be committed, and silently accepting it would teach the habit.
 */
export function parseConfig(raw: string): ParseResult {
  let parsed: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'expected a JSON object' };
    }
    parsed = value as Record<string, unknown>;
  } catch (err) {
    return { ok: false, error: `invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }

  if ('password' in parsed || 'passphrase' in parsed) {
    return {
      ok: false,
      error: 'contains a "password"/"passphrase" field — secrets belong in the OS keychain, not in this file. Remove it and run Set Up Remote again.'
    };
  }

  const version = typeof parsed.version === 'number' ? parsed.version : 0;
  if (version !== CONFIG_VERSION) {
    return { ok: false, error: `unsupported version ${version} (this build understands ${CONFIG_VERSION})` };
  }

  const id = str(parsed.id).toLowerCase();
  if (!isValidProfileId(id)) {
    return { ok: false, error: `"id" must be 8 lowercase hex characters, got ${JSON.stringify(parsed.id)}` };
  }

  const protocol = str(parsed.protocol) as Protocol;
  if (!PROTOCOLS.includes(protocol)) {
    return { ok: false, error: `"protocol" must be one of ${PROTOCOLS.join(', ')}` };
  }

  const host = str(parsed.host);
  if (!host) {
    return { ok: false, error: '"host" is required' };
  }

  const username = str(parsed.username);
  if (!username) {
    return { ok: false, error: '"username" is required' };
  }

  const port = typeof parsed.port === 'number' ? Math.trunc(parsed.port) : NaN;
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return { ok: false, error: `"port" must be between 1 and 65535, got ${JSON.stringify(parsed.port)}` };
  }

  const auth: AuthMethod = str(parsed.auth) === 'privateKey' ? 'privateKey' : 'password';
  if (auth === 'privateKey' && protocol !== 'sftp') {
    return { ok: false, error: 'private-key auth is only valid for the sftp protocol' };
  }

  const maxFileSizeKB =
    typeof parsed.maxFileSizeKB === 'number' && parsed.maxFileSizeKB > 0
      ? Math.trunc(parsed.maxFileSizeKB)
      : DEFAULT_MAX_FILE_SIZE_KB;

  const now = Date.now();
  return {
    ok: true,
    config: {
      version: CONFIG_VERSION,
      id,
      name: str(parsed.name) || host,
      protocol,
      host,
      port,
      username,
      auth,
      privateKeyPath: str(parsed.privateKeyPath) || undefined,
      remoteRoot: normalizeRemotePath(str(parsed.remoteRoot) || '/'),
      readOnly: parsed.readOnly === true,
      confirmOnSave: typeof parsed.confirmOnSave === 'boolean' ? parsed.confirmOnSave : undefined,
      backupOnSave: typeof parsed.backupOnSave === 'boolean' ? parsed.backupOnSave : undefined,
      ftpSecureRejectUnauthorized:
        typeof parsed.ftpSecureRejectUnauthorized === 'boolean' ? parsed.ftpSecureRejectUnauthorized : undefined,
      roots: strArray(parsed.roots, []).map((r) => normalizeRemotePath(r)),
      excludes: strArray(parsed.excludes, [...DEFAULT_EXCLUDES]),
      maxFileSizeKB,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : now,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now
    }
  };
}
