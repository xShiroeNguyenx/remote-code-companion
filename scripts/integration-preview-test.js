'use strict';
// Integration test for the local preview: builds a real WordPress install with
// the machine's PHP, serves it, and checks that the theme from the workspace
// folder is what actually renders.
//
// Kept out of `npm test` and out of `test:integration` because it downloads
// WordPress (~31 MB) the first time. Run it with `npm run test:preview`.
//
// The two claims worth proving here:
//   1. a preview can be produced from nothing but a PHP binary — no MySQL, no
//      Apache, no Docker, and no working php.ini;
//   2. the theme is *linked*, not copied, so an edit shows up on reload — which
//      is the entire point of previewing before pushing.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const outDir = path.join(process.cwd(), 'out');
const { findPhp } = require(path.join(outDir, 'php', 'php-runtime.js'));
const { ensureSite, removeSite } = require(path.join(outDir, 'preview', 'wordpress-site.js'));
const { PreviewServers, findFreePort } = require(path.join(outDir, 'preview', 'preview-server.js'));

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m) => console.warn('  [warn]', m),
  error: (m, e) => console.error('  [error]', m, e || '')
};

const PROFILE_ID = 'ab12cd34';
const MARKER = 'RCC-PREVIEW-MARKER';

function writeTheme(dir, headline) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'style.css'),
    ['/*', 'Theme Name: RCC Test Theme', 'Version: 1.0', '*/', 'body { color: #222; }'].join('\n')
  );
  fs.writeFileSync(
    path.join(dir, 'index.php'),
    [
      '<?php',
      '// Minimal theme: enough for WordPress to render a page.',
      '?>',
      '<!DOCTYPE html><html><head><title>preview</title></head><body>',
      `<h1 id="marker">${headline}</h1>`,
      '<?php echo esc_html( get_bloginfo( "name" ) ); ?>',
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
    console.log('  no PHP on this machine — preview test skipped');
    return;
  }
  console.log(`  using PHP ${runtime.version} at ${runtime.exe}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-preview-'));
  // Reuse a cache across runs so the 31 MB download happens once per machine.
  const storageDir = path.join(os.tmpdir(), 'rcc-preview-storage');
  const themeDir = path.join(tmp, 'workspace', 'wp-content', 'themes', 'rcc-test-theme');
  writeTheme(themeDir, MARKER);

  const servers = new PreviewServers(logger);
  try {
    const port = await findFreePort(8830);
    const paths = await ensureSite({
      runtime,
      storageDir,
      profileId: PROFILE_ID,
      themeSourceDir: themeDir,
      themeName: 'rcc-test-theme',
      port,
      logger,
      report: (m) => console.log('   ' + m)
    });

    assert.ok(fs.existsSync(path.join(paths.root, 'wp-settings.php')), 'WordPress core should be installed');
    assert.ok(fs.existsSync(path.join(paths.root, 'wp-content', 'db.php')), 'the SQLite drop-in should be in place');
    const dropIn = fs.readFileSync(path.join(paths.root, 'wp-content', 'db.php'), 'utf8');
    assert.ok(!dropIn.includes('{SQLITE_'), 'every drop-in placeholder must be replaced');
    console.log('  site built: core + SQLite drop-in OK');

    // The theme must be linked, not copied.
    const linked = path.join(paths.themesDir, 'rcc-test-theme');
    const stat = fs.lstatSync(linked);
    assert.ok(stat.isSymbolicLink(), 'the theme should be linked into the site');
    console.log('  theme linked from the workspace OK');

    await servers.start(PROFILE_ID, runtime, paths, port);
    console.log(`  server up on ${port}`);

    const home = await fetch(port, '/');
    assert.strictEqual(home.status, 200, `expected 200, got ${home.status}: ${home.body.slice(0, 300)}`);
    assert.ok(home.body.includes(MARKER), `the workspace theme should render; got: ${home.body.slice(0, 300)}`);
    console.log('  GET / renders the workspace theme OK');

    // No PHP notices leaking into the page — a broken php.ini must not matter.
    assert.ok(!/Unable to load dynamic library/i.test(home.body), 'startup warnings must not reach the page');
    assert.ok(!/Fatal error/i.test(home.body), 'the page must render without a fatal error');
    console.log('  page is free of PHP startup warnings and fatals OK');

    // Editing the theme must be visible on the next request: this is what makes
    // the preview useful for checking AI edits before they are pushed.
    writeTheme(themeDir, MARKER + '-EDITED');
    const afterEdit = await fetch(port, '/');
    assert.ok(
      afterEdit.body.includes(MARKER + '-EDITED'),
      'an edit to the workspace theme should appear without rebuilding the site'
    );
    console.log('  live edit picked up on reload OK');

    // A second start must reuse the site rather than rebuild it.
    const again = await ensureSite({
      runtime,
      storageDir,
      profileId: PROFILE_ID,
      themeSourceDir: themeDir,
      themeName: 'rcc-test-theme',
      port,
      logger,
      report: () => undefined
    });
    assert.strictEqual(again.root, paths.root);
    const stillUp = await fetch(port, '/');
    assert.strictEqual(stillUp.status, 200, 'the site should still serve after a re-ensure');
    console.log('  re-running ensureSite is idempotent OK');

    console.log('\n  integration-preview-test OK\n');
  } finally {
    await servers.stopAll();
    removeSite(storageDir, PROFILE_ID);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nintegration-preview-test FAILED');
    console.error(err);
    process.exit(1);
  }
);
