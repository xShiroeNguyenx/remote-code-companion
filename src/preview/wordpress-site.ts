import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import { formatError, Logger } from '../core/logger';
import { baseArgs, PhpRuntime, runPhp, usableExtensions, WORDPRESS_EXTENSIONS } from '../php/php-runtime';

/**
 * A throwaway WordPress install, built from nothing but the machine's PHP.
 *
 * Two modes:
 *  - **empty**: SQLite via WordPress's own integration plugin. Enough to see a
 *    theme render, and needs no database server at all.
 *  - **cloned**: a copy of production's database in a private MySQL instance, with
 *    the real plugins linked in. This is the one that looks like the live site.
 *
 * Nothing here writes into the workspace folder: the site lives in extension
 * storage and the theme is linked in, so a preview can never add files to what a
 * push would upload.
 */

const WP_URL = 'https://wordpress.org/latest.zip';
const SQLITE_PLUGIN_URL = 'https://downloads.wordpress.org/plugin/sqlite-database-integration.zip';
const SQLITE_PLUGIN_DIR = 'sqlite-database-integration';

export interface SitePaths {
  /** Document root of the WordPress install. */
  root: string;
  themesDir: string;
  pluginsDir: string;
  routerFile: string;
}

/** A cloned production database, served by the extension's own MySQL instance. */
export interface PreviewDatabase {
  name: string;
  port: number;
  tablePrefix: string;
}

export function sitePaths(storageDir: string, profileId: string): SitePaths {
  const root = path.join(storageDir, 'preview', profileId);
  return {
    root,
    themesDir: path.join(root, 'wp-content', 'themes'),
    pluginsDir: path.join(root, 'wp-content', 'plugins'),
    routerFile: path.join(root, 'rcc-router.php')
  };
}

export interface EnsureSiteOptions {
  runtime: PhpRuntime;
  storageDir: string;
  profileId: string;
  /** Directory holding the theme to preview, inside the user's workspace. */
  themeSourceDir: string;
  themeName: string;
  /** Local wp-content/plugins, linked in when present so the theme's deps exist. */
  pluginsSourceDir?: string;
  /** When set, the site uses this cloned database instead of an empty SQLite one. */
  database?: PreviewDatabase;
  port: number;
  logger: Logger;
  report(message: string): void;
}

function download(url: string, target: string, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects while downloading ' + url));
      return;
    }
    https
      .get(url, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          download(res.headers.location, target, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status} downloading ${url}`));
          return;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // Download to a .part file so an interrupted run cannot leave a truncated
        // archive that looks cached and valid next time.
        const partial = target + '.part';
        const out = fs.createWriteStream(partial);
        res.pipe(out);
        out.on('error', reject);
        out.on('finish', () =>
          out.close(() => {
            fs.renameSync(partial, target);
            resolve();
          })
        );
      })
      .on('error', reject);
  });
}

async function cachedDownload(url: string, target: string, report: (m: string) => void, what: string): Promise<void> {
  if (fs.existsSync(target) && fs.statSync(target).size > 0) {
    return;
  }
  report(`Downloading ${what}...`);
  await download(url, target);
}

/** Unzip using PHP's ZipArchive, so no archive library has to be bundled. */
async function unzip(runtime: PhpRuntime, zipFile: string, destDir: string, extensions: string[]): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const script = [
    '<?php',
    '$zip = new ZipArchive();',
    'if ($zip->open($argv[1]) !== true) { fwrite(STDERR, "cannot open archive"); exit(1); }',
    'if (!$zip->extractTo($argv[2])) { fwrite(STDERR, "cannot extract archive"); exit(1); }',
    '$zip->close();'
  ].join('\n');
  const scriptFile = path.join(path.dirname(zipFile), 'rcc-unzip.php');
  fs.writeFileSync(scriptFile, script, 'utf8');
  const result = await runPhp(runtime, [...baseArgs(runtime, extensions), scriptFile, zipFile, destDir]);
  if (result.code !== 0) {
    throw new Error(`unpacking ${path.basename(zipFile)} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

function randomSalt(): string {
  // Only protects a local throwaway install, but a constant would be a bad habit.
  return crypto.randomBytes(48).toString('base64').replace(/'/g, '.');
}

function wpConfig(url: string, database: PreviewDatabase | undefined): string {
  const keys = [
    'AUTH_KEY',
    'SECURE_AUTH_KEY',
    'LOGGED_IN_KEY',
    'NONCE_KEY',
    'AUTH_SALT',
    'SECURE_AUTH_SALT',
    'LOGGED_IN_SALT',
    'NONCE_SALT'
  ];
  const db = database
    ? [
        `define('DB_NAME', '${database.name}');`,
        "define('DB_USER', 'root');",
        "define('DB_PASSWORD', '');",
        `define('DB_HOST', '127.0.0.1:${database.port}');`,
        `$table_prefix = '${database.tablePrefix}';`
      ]
    : [
        // Values the SQLite drop-in ignores, but WordPress insists on having.
        "define('DB_NAME', 'wordpress');",
        "define('DB_USER', 'root');",
        "define('DB_PASSWORD', '');",
        "define('DB_HOST', 'localhost');",
        "$table_prefix = 'wp_';"
      ];

  return [
    '<?php',
    '// Generated by Remote Code Companion for a local preview. Safe to delete.',
    ...db,
    "define('DB_CHARSET', 'utf8mb4');",
    "define('DB_COLLATE', '');",
    ...keys.map((key) => `define('${key}', '${randomSalt()}');`),
    // Defining these overrides whatever the cloned database says, which is what
    // keeps a copy of production from redirecting the browser to the live site.
    // Media URLs inside post content still point at production, so images load
    // from there — read-only, and far cheaper than downloading the uploads folder.
    `define('WP_HOME', '${url}');`,
    `define('WP_SITEURL', '${url}');`,
    "define('WP_DEBUG', true);",
    "define('WP_DEBUG_DISPLAY', true);",
    "define('WP_DEBUG_LOG', false);",
    "define('FS_METHOD', 'direct');",
    "define('AUTOMATIC_UPDATER_DISABLED', true);",
    "define('WP_AUTO_UPDATE_CORE', false);",
    "define('DISALLOW_FILE_MODS', true);",
    // A preview must never send mail on behalf of the real site.
    "define('WP_ENVIRONMENT_TYPE', 'local');",
    "if (!defined('ABSPATH')) { define('ABSPATH', __DIR__ . '/'); }",
    "require_once ABSPATH . 'wp-settings.php';",
    ''
  ].join('\n');
}

const ROUTER = [
  '<?php',
  "// Router for PHP's built-in server: serve real files, send everything else to",
  '// WordPress so permalinks work.',
  "$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);",
  "$file = __DIR__ . '/' . ltrim($path, '/');",
  "if ($path !== '/' && file_exists($file) && !is_dir($file)) { return false; }",
  "require __DIR__ . '/index.php';",
  ''
].join('\n');

/**
 * Install the SQLite drop-in. The plugin ships `db.copy` with placeholders, and
 * `{SQLITE_PLUGIN}` occurs several times — replacing only the first leaves a file
 * that half-works.
 */
function writeSqliteDropIn(root: string): void {
  const pluginDir = path.join(root, 'wp-content', 'plugins', SQLITE_PLUGIN_DIR);
  const contents = fs
    .readFileSync(path.join(pluginDir, 'db.copy'), 'utf8')
    .split("'{SQLITE_IMPLEMENTATION_FOLDER_PATH}'")
    .join(JSON.stringify(pluginDir.split(path.sep).join('/')))
    .split('{SQLITE_PLUGIN}')
    .join(`${SQLITE_PLUGIN_DIR}/load.php`);
  if (contents.includes('{SQLITE_')) {
    throw new Error('the SQLite drop-in still has unreplaced placeholders');
  }
  fs.writeFileSync(path.join(root, 'wp-content', 'db.php'), contents, 'utf8');
}

/** Link a workspace directory into the site, copying only if links are refused. */
function linkInto(targetDir: string, name: string, sourceDir: string, logger: Logger): void {
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, name);
  try {
    const existing = fs.lstatSync(target);
    if (existing.isSymbolicLink()) {
      if (fs.realpathSync(target) === fs.realpathSync(sourceDir)) {
        return;
      }
      fs.unlinkSync(target);
    } else {
      fs.rmSync(target, { recursive: true, force: true });
    }
  } catch {
    // not there yet
  }
  try {
    fs.symlinkSync(sourceDir, target, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (err) {
    // Junctions need no privileges on Windows, but a filesystem may still refuse.
    // Copying keeps the preview working; it just will not track later edits.
    logger.warn(`[preview] could not link ${name} (${formatError(err)}) — copying instead`);
    fs.cpSync(sourceDir, target, { recursive: true });
  }
}

/**
 * Link each plugin that exists locally. Linking them individually, rather than the
 * whole plugins directory, keeps WordPress's own bundled plugins and the SQLite
 * drop-in's plugin in place.
 */
function linkPlugins(pluginsDir: string, sourceDir: string, logger: Logger): number {
  let linked = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }
    linkInto(pluginsDir, entry.name, path.join(sourceDir, entry.name), logger);
    linked++;
  }
  return linked;
}

async function runWpScript(
  runtime: PhpRuntime,
  root: string,
  extensions: string[],
  body: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const file = path.join(root, 'rcc-task.php');
  fs.writeFileSync(file, ['<?php', ...body, ''].join('\n'), 'utf8');
  const result = await runPhp(runtime, [...baseArgs(runtime, extensions), file]);
  fs.rmSync(file, { force: true });
  return result;
}

/**
 * Make sure a working site exists for this profile, with the theme linked and
 * activated. Safe to call repeatedly: downloads are cached, and the install step is
 * skipped once WordPress reports itself installed — which a cloned production
 * database already does.
 */
export async function ensureSite(options: EnsureSiteOptions): Promise<SitePaths> {
  const { runtime, storageDir, profileId, themeSourceDir, themeName, pluginsSourceDir, database, port, logger, report } =
    options;
  const paths = sitePaths(storageDir, profileId);
  const extensions = usableExtensions(runtime, WORDPRESS_EXTENSIONS);
  const cacheDir = path.join(storageDir, 'preview', 'cache');
  const url = `http://127.0.0.1:${port}`;

  if (!fs.existsSync(path.join(paths.root, 'wp-settings.php'))) {
    const zip = path.join(cacheDir, 'wordpress-latest.zip');
    await cachedDownload(WP_URL, zip, report, 'WordPress');
    report('Unpacking WordPress...');
    const staging = path.join(cacheDir, 'unpack-' + profileId);
    fs.rmSync(staging, { recursive: true, force: true });
    await unzip(runtime, zip, staging, extensions);
    // The archive contains a single wordpress/ directory.
    const inner = path.join(staging, 'wordpress');
    fs.mkdirSync(paths.root, { recursive: true });
    for (const entry of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, entry), path.join(paths.root, entry));
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }

  const dropIn = path.join(paths.root, 'wp-content', 'db.php');
  if (database) {
    // A real MySQL database is in play: the SQLite drop-in would hijack it.
    fs.rmSync(dropIn, { force: true });
  } else if (!fs.existsSync(dropIn)) {
    const zip = path.join(cacheDir, 'sqlite-database-integration.zip');
    await cachedDownload(SQLITE_PLUGIN_URL, zip, report, 'the SQLite database plugin');
    report('Setting up the database...');
    await unzip(runtime, zip, paths.pluginsDir, extensions);
    writeSqliteDropIn(paths.root);
  }

  // Rewritten every start: the port, and therefore the site URL, can change.
  fs.writeFileSync(path.join(paths.root, 'wp-config.php'), wpConfig(url, database), 'utf8');
  fs.writeFileSync(paths.routerFile, ROUTER, 'utf8');

  linkInto(paths.themesDir, themeName, themeSourceDir, logger);
  if (pluginsSourceDir) {
    const count = linkPlugins(paths.pluginsDir, pluginsSourceDir, logger);
    logger.info(`[preview] linked ${count} plugin(s) from the workspace`);
  }

  report('Preparing WordPress...');
  const result = await runWpScript(runtime, paths.root, extensions, [
    "define('WP_INSTALLING', true);",
    "require_once __DIR__ . '/wp-load.php';",
    "require_once ABSPATH . 'wp-admin/includes/upgrade.php';",
    'if (!is_blog_installed()) {',
    "  $install = wp_install('Local preview', 'admin', 'admin@example.invalid', true, '', 'admin');",
    '  if (is_wp_error($install)) { fwrite(STDERR, $install->get_error_message()); exit(1); }',
    '}',
    // The site URL follows the port, which is chosen at start time. Writing the
    // options too (not just the constants) keeps admin links pointing locally.
    `update_option('home', ${JSON.stringify(url)});`,
    `update_option('siteurl', ${JSON.stringify(url)});`,
    `switch_theme(${JSON.stringify(themeName)});`,
    "if (!get_option('permalink_structure')) { update_option('permalink_structure', '/%postname%/'); }",
    'echo "ready";'
  ]);
  if (result.code !== 0) {
    throw new Error(`preparing WordPress failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  logger.info(`[preview] site ready for ${themeName} at ${paths.root}`);
  return paths;
}

/**
 * Remove a preview site entirely; the cached downloads are kept so the next
 * preview does not re-download WordPress.
 *
 * Retries because Windows can still hold handles from the server process that was
 * serving this directory a moment ago.
 */
export function removeSite(storageDir: string, profileId: string): void {
  const target = sitePaths(storageDir, profileId).root;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (Date.now() > deadline || (code !== 'EBUSY' && code !== 'ENOTEMPTY' && code !== 'EPERM')) {
        throw err;
      }
    }
  }
}
