import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../core/logger';

/**
 * A usable PHP CLI, found on the machine rather than shipped with the extension
 * (a bundled binary would make the vsix platform-specific).
 *
 * Everything here runs PHP with `-n`, which ignores php.ini entirely, and then
 * injects the extensions we need. That is deliberate: a developer machine's
 * php.ini is frequently broken or tuned for something else — the one on this
 * machine has a corrupt `extension_dir` and cannot load any extension at all —
 * and inheriting that would make the extension fail for reasons the user cannot
 * see. Bypassing it makes behaviour identical everywhere.
 */
export interface PhpRuntime {
  exe: string;
  version: string;
  /** `<php dir>/ext`, passed explicitly since php.ini is bypassed. */
  extensionDir: string;
}

/** What WordPress needs from PHP for the local preview to work. */
export const WORDPRESS_EXTENSIONS = [
  // WordPress refuses to run without a MySQL driver, even when the site is
  // configured for SQLite, so both families are loaded when present.
  'mysqli',
  'pdo_mysql',
  'pdo_sqlite',
  'sqlite3',
  'mbstring',
  'zip',
  'gd',
  'curl',
  'openssl',
  'fileinfo',
  'exif',
  'dom',
  'xml',
  'iconv',
  'simplexml',
  'sodium'
];

const WINDOWS_CANDIDATES = [
  'C:/xampp/php/php.exe',
  'C:/xampp/php-8.2/php.exe',
  'C:/xampp/php-8.1/php.exe',
  'C:/xampp/php-8.3/php.exe',
  'C:/php/php.exe',
  'C:/tools/php/php.exe',
  'C:/Program Files/php/php.exe'
];

const UNIX_CANDIDATES = ['/usr/local/bin/php', '/usr/bin/php', '/opt/homebrew/bin/php', '/opt/local/bin/php'];

function run(exe: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true });
    } catch {
      resolve({ code: -1, stdout: '', stderr: 'spawn failed' });
      return;
    }
    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', () => resolve({ code: -1, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Parse `PHP 8.2.29 (cli) ...` out of `php -v`. */
export function parsePhpVersion(output: string): string | undefined {
  const match = /PHP\s+(\d+\.\d+\.\d+)/i.exec(output);
  return match ? match[1] : undefined;
}

/** Glob-free discovery of XAMPP-style versioned directories. */
function windowsGlobCandidates(): string[] {
  const found: string[] = [];
  for (const base of ['C:/xampp', 'C:/laragon/bin/php', 'C:/wamp64/bin/php']) {
    let entries: string[];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const exe = path.join(base, entry, 'php.exe');
      if (fs.existsSync(exe)) {
        found.push(exe.split(path.sep).join('/'));
      }
    }
  }
  return found;
}

async function probe(exe: string, logger: Logger): Promise<PhpRuntime | undefined> {
  const result = await run(exe, ['-n', '-v']);
  const version = parsePhpVersion(result.stdout + result.stderr);
  if (result.code !== 0 || !version) {
    return undefined;
  }

  // Ask PHP where it actually lives. A name resolved from PATH ("php.exe") has
  // no directory of its own, and guessing one would point extension_dir at the
  // working directory — which silently costs us every extension.
  const located = await run(exe, ['-n', '-r', 'echo PHP_BINARY;']);
  const binary = located.code === 0 && located.stdout.trim() ? located.stdout.trim() : exe;

  // The extension directory comes from the binary location, never from php.ini:
  // php.ini is bypassed, and on this machine its value is corrupt.
  const dir = path.dirname(binary);
  const extensionDir = ['ext', 'extensions', '.'].map((sub) => path.join(dir, sub)).find((p) => fs.existsSync(p)) ?? dir;
  logger.info(`[php] using ${binary} (PHP ${version}), extensions from ${extensionDir}`);
  return { exe: binary, version, extensionDir };
}

/**
 * Find PHP: an explicit setting first, then PATH, then the usual install
 * locations. Returns undefined when the machine simply has no PHP.
 */
export async function findPhp(configuredPath: string | undefined, logger: Logger): Promise<PhpRuntime | undefined> {
  const configured = (configuredPath ?? '').trim();
  if (configured) {
    const found = await probe(configured, logger);
    if (!found) {
      logger.warn(`[php] configured php path is not usable: ${configured}`);
    }
    return found;
  }

  const onPath = await probe(process.platform === 'win32' ? 'php.exe' : 'php', logger);
  if (onPath) {
    return onPath;
  }

  const candidates = process.platform === 'win32' ? [...windowsGlobCandidates(), ...WINDOWS_CANDIDATES] : UNIX_CANDIDATES;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const found = await probe(candidate, logger);
    if (found) {
      return found;
    }
  }
  return undefined;
}

/**
 * Keep only the extensions that exist as loadable files. Several of them —
 * dom, xml, simplexml, iconv — are compiled into PHP on many builds, and asking
 * to load those prints a startup warning on every single invocation, which then
 * pollutes the output we parse.
 */
export function usableExtensions(runtime: PhpRuntime, wanted: string[]): string[] {
  const suffixes = process.platform === 'win32' ? ['php_%.dll'] : ['%.so'];
  return wanted.filter((name) =>
    suffixes.some((pattern) => fs.existsSync(path.join(runtime.extensionDir, pattern.replace('%', name))))
  );
}

/**
 * Arguments that make PHP behave predictably: no php.ini, explicit extension
 * directory, and only the extensions we asked for.
 */
export function baseArgs(runtime: PhpRuntime, extensions: string[] = []): string[] {
  const args = ['-n', '-d', `extension_dir=${runtime.extensionDir}`];
  for (const extension of extensions) {
    args.push('-d', `extension=${extension}`);
  }
  return args;
}

export async function runPhp(
  runtime: PhpRuntime,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(runtime.exe, args);
}
