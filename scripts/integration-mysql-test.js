'use strict';
// Integration test for the cloned-database preview: a private MariaDB instance
// owned by the extension, a WordPress install pointed at it, and the workspace
// theme rendering from it.
//
// The claims being proven:
//   1. the extension can run its own database server — its own data directory and
//      port — without the user starting XAMPP and without touching whatever else
//      lives in their data directory;
//   2. WordPress runs against that database, not SQLite, and still serves the
//      theme from the workspace folder;
//   3. it shuts down cleanly, so the data directory does not need recovery next time.
//
// Run with `npm run test:mysql`. Skipped when the machine has no MySQL/MariaDB.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const outDir = path.join(process.cwd(), 'out');
const { findPhp } = require(path.join(outDir, 'php', 'php-runtime.js'));
const { findMysql, MysqlServer, findFreePort: freeDbPort } = require(path.join(outDir, 'preview', 'mysql-server.js'));
const { ensureSite, removeSite } = require(path.join(outDir, 'preview', 'wordpress-site.js'));
const { PreviewServers, findFreePort } = require(path.join(outDir, 'preview', 'preview-server.js'));

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m) => console.warn('  [warn]', m),
  error: (m, e) => console.error('  [error]', m, e || '')
};

const PROFILE_ID = 'cd34ab12';
const DB_NAME = 'rcc_preview_test';
const MARKER = 'RCC-MYSQL-MARKER';

function writeTheme(dir, headline) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'style.css'), ['/*', 'Theme Name: RCC MySQL Theme', 'Version: 1.0', '*/'].join('\n'));
  fs.writeFileSync(
    path.join(dir, 'index.php'),
    [
      '<?php',
      '?>',
      '<!DOCTYPE html><html><head><title>preview</title></head><body>',
      `<h1>${headline}</h1>`,
      '<?php echo esc_html( get_bloginfo( "name" ) ); ?>',
      '<?php echo esc_html( get_option( "siteurl" ) ); ?>',
      '</body></html>'
    ].join('\n')
  );
}

function fetch(port, urlPath) {
  return new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port, path: urlPath, timeout: 30000 }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      })
      .on('error', (e) => resolve({ status: 0, body: String(e) }));
  });
}

async function main() {
  const runtime = await findPhp(undefined, logger);
  if (!runtime) {
    console.log('  no PHP on this machine — mysql preview test skipped');
    return;
  }
  const binaries = findMysql(undefined, logger);
  if (!binaries) {
    console.log('  no MySQL/MariaDB on this machine — test skipped');
    return;
  }
  console.log(`  PHP ${runtime.version}, mysqld at ${binaries.mysqld}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-mysql-it-'));
  const storageDir = path.join(os.tmpdir(), 'rcc-preview-storage');
  const dataDir = path.join(tmp, 'dbdata');
  const themeDir = path.join(tmp, 'workspace', 'wp-content', 'themes', 'rcc-mysql-theme');
  const pluginsDir = path.join(tmp, 'workspace', 'wp-content', 'plugins');
  writeTheme(themeDir, MARKER);

  // A plugin in the workspace must be linked in, since a real theme often needs one.
  fs.mkdirSync(path.join(pluginsDir, 'rcc-fake-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginsDir, 'rcc-fake-plugin', 'rcc-fake-plugin.php'),
    ['<?php', '/* Plugin Name: RCC Fake Plugin */'].join('\n')
  );

  const mysql = new MysqlServer(binaries, logger);
  const servers = new PreviewServers(logger);
  try {
    const dbPort = await freeDbPort(33070);
    console.log('  starting a private database...');
    await mysql.start(dataDir, dbPort, (m) => console.log('   ' + m));
    assert.ok(mysql.isRunning(), 'the database should be running');
    assert.strictEqual(mysql.port, dbPort);
    // It must be a separate instance, not the machine's usual one on 3306.
    assert.notStrictEqual(dbPort, 3306, 'the preview database must not use the default port');
    console.log(`  database up on ${dbPort} with its own data dir OK`);

    mysql.recreateDatabase(DB_NAME);
    const listed = mysql.query('SHOW DATABASES;');
    assert.ok(listed.output.includes(DB_NAME), 'the database should exist');

    const httpPort = await findFreePort(8840);
    const paths = await ensureSite({
      runtime,
      storageDir,
      profileId: PROFILE_ID,
      themeSourceDir: themeDir,
      themeName: 'rcc-mysql-theme',
      pluginsSourceDir: pluginsDir,
      database: { name: DB_NAME, port: dbPort, tablePrefix: 'wp_' },
      port: httpPort,
      logger,
      report: (m) => console.log('   ' + m)
    });

    // MySQL mode must not leave the SQLite drop-in in place: it would hijack the
    // connection and quietly ignore the cloned data.
    assert.ok(
      !fs.existsSync(path.join(paths.root, 'wp-content', 'db.php')),
      'the SQLite drop-in must be removed when a real database is used'
    );
    console.log('  SQLite drop-in absent in MySQL mode OK');

    const config = fs.readFileSync(path.join(paths.root, 'wp-config.php'), 'utf8');
    assert.match(config, new RegExp(`DB_NAME'\\s*,\\s*'${DB_NAME}'`), 'wp-config should point at the cloned database');
    assert.match(config, new RegExp(`127\\.0\\.0\\.1:${dbPort}`), 'wp-config should point at the private port');

    // WordPress created its schema in MySQL.
    const tables = mysql.query(`SHOW TABLES FROM \`${DB_NAME}\`;`);
    assert.ok(tables.output.includes('wp_options'), `expected wp_options; got: ${tables.output.slice(0, 200)}`);
    console.log('  WordPress schema created in MySQL OK');

    // The workspace plugin was linked in.
    const linkedPlugin = path.join(paths.pluginsDir, 'rcc-fake-plugin');
    assert.ok(fs.existsSync(linkedPlugin), 'the workspace plugin should be linked into the site');
    assert.ok(fs.lstatSync(linkedPlugin).isSymbolicLink(), 'plugins should be linked, not copied');
    console.log('  workspace plugin linked OK');

    await servers.start(PROFILE_ID, runtime, paths, httpPort);
    const home = await fetch(httpPort, '/');
    assert.strictEqual(home.status, 200, `expected 200, got ${home.status}: ${home.body.slice(0, 400)}`);
    assert.ok(home.body.includes(MARKER), 'the workspace theme should render from the MySQL-backed site');
    assert.ok(!/Error establishing a database connection/i.test(home.body), 'the database connection must work');
    // The site URL must be local, so a cloned production database cannot redirect
    // the browser to the live site.
    assert.ok(home.body.includes(`127.0.0.1:${httpPort}`), 'siteurl should be the local one');
    console.log('  page renders against MySQL, site URL stays local OK');

    console.log('  shutting down...');
    await servers.stopAll();
    await mysql.stop();
    assert.ok(!mysql.isRunning(), 'the database should be stopped');
    // A clean shutdown leaves no crash-recovery marker behind.
    assert.ok(!fs.existsSync(path.join(dataDir, 'mysql.sock')), 'no stale socket file should remain');
    console.log('  clean shutdown OK');

    console.log('\n  integration-mysql-test OK\n');
  } finally {
    await servers.stopAll();
    await mysql.stop();
    try {
      removeSite(storageDir, PROFILE_ID);
    } catch {
      // best effort
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nintegration-mysql-test FAILED');
    console.error(err);
    process.exit(1);
  }
);
