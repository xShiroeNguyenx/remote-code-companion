'use strict';
// Load the extension's runtime modules from a tree containing *only* what the vsix
// ships, and nothing else.
//
// This is the check that catches the classic packaging failure: a dependency that
// resolves during development because it sits in the local node_modules, and throws
// MODULE_NOT_FOUND on a user's machine because .vscodeignore excluded it. Listing
// files (verify-package.js) cannot catch it; actually requiring them can.
//
// `vsce ls` produces the file list, applying .vscodeignore exactly as packaging
// does. Those files are copied into a temporary directory, which is then used as
// the working directory for the requires.

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = process.cwd();

// vscode-free modules that pull in every runtime dependency between them.
const MODULES = [
  'out/connection/ftp-remote-client.js', // basic-ftp
  'out/connection/sftp-remote-client.js', // ssh2-sftp-client -> ssh2 -> asn1, bcrypt-pbkdf, tweetnacl
  'out/connection/ssh-exec.js', // ssh2 directly
  'out/connection/connection-manager.js',
  'out/preview/mysql-server.js',
  'out/preview/wordpress-site.js',
  'out/preview/dump-sanitise.js',
  'out/php/php-runtime.js',
  'out/php/php-lint.js',
  'out/core/connect-advice.js',
  'out/mirror/classify.js',
  'out/mirror/manifest.js',
  'out/profiles/config-file.js'
];

function packagedFiles() {
  const res = spawnSync('npx', ['vsce', 'ls'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32'
  });
  if (res.status !== 0) {
    console.error('`vsce ls` failed:\n' + (res.stderr || res.stdout || ''));
    process.exit(1);
  }
  return res.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/\\/g, '/'));
}

const files = packagedFiles();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-runtime-'));

let copied = 0;
for (const rel of files) {
  const source = path.join(root, rel);
  if (!fs.existsSync(source) || fs.statSync(source).isDirectory()) {
    continue;
  }
  const target = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  copied++;
}
console.log(`copied ${copied} packaged files into a clean tree`);

// Requiring inside that tree: resolution can only find what the vsix ships.
const probe = MODULES.map(
  (m) => `try { require(${JSON.stringify('./' + m)}); ok.push(${JSON.stringify(m)}); }` +
    ` catch (e) { bad.push(${JSON.stringify(m)} + ' -> ' + (e && e.code ? e.code + ': ' : '') + (e && e.message ? e.message.split('\\n')[0] : String(e))); }`
).join('\n');

const script = [
  'const ok = [];',
  'const bad = [];',
  probe,
  // Instantiate the two clients: a constructor is where a missing native binding
  // would surface rather than at require time.
  'try {',
  "  const { FtpRemoteClient } = require('./out/connection/ftp-remote-client.js');",
  "  const { SftpRemoteClient } = require('./out/connection/sftp-remote-client.js');",
  '  const profile = {',
  "    id: 'ab12cd34', name: 'probe', protocol: 'sftp', host: 'example.invalid', port: 22,",
  "    username: 'u', auth: 'password', remoteRoot: '/', readOnly: true, createdAt: 0, updatedAt: 0",
  '  };',
  "  const logger = { debug(){}, info(){}, warn(){}, error(){} };",
  '  new FtpRemoteClient(Object.assign({}, profile, { protocol: "ftp", port: 21 }), logger);',
  '  new SftpRemoteClient(profile, logger);',
  "  ok.push('clients constructed');",
  '} catch (e) {',
  "  bad.push('client construction -> ' + (e && e.message ? e.message.split('\\n')[0] : String(e)));",
  '}',
  'console.log(JSON.stringify({ ok, bad }));'
].join('\n');

const result = spawnSync(process.execPath, ['-e', script], { cwd: tmp, encoding: 'utf8' });
const output = (result.stdout || '').trim().split(/\r?\n/).pop() || '';

let report;
try {
  report = JSON.parse(output);
} catch {
  console.error('probe produced no result:\n' + (result.stdout || '') + (result.stderr || ''));
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
}

for (const entry of report.ok) {
  console.log('  ok   ' + entry);
}
for (const entry of report.bad) {
  console.error('  FAIL ' + entry);
}

fs.rmSync(tmp, { recursive: true, force: true });

assert.strictEqual(
  report.bad.length,
  0,
  `${report.bad.length} module(s) cannot load from the packaged tree — the vsix is missing a runtime dependency`
);
console.log('verify-runtime OK');
