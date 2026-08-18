'use strict';
// Verifies what `vsce package` would ship, before it ships it.
//
// Two failure modes this catches, both from PLAN.md §13:
//   1. a new transitive dependency of ssh2 missing from the vsix → the
//      extension throws MODULE_NOT_FOUND on a user's machine and nowhere else;
//   2. a native binding (`cpu-features`, `*.node`) sneaking in → the vsix stops
//      being platform-neutral.
// Plus the ordinary embarrassments: sources, sourcemaps or test files shipped,
// build tooling packed as if it were a runtime dependency.
//
// Runs `vsce ls`, which applies .vscodeignore exactly as packaging does.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const REQUIRED = [
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  pkg.main.replace(/^\.\//, ''),
  ...(pkg.icon ? [pkg.icon] : [])
];

// Runtime dependencies must be present as directories under node_modules/.
const REQUIRED_DIRS = Object.keys(pkg.dependencies || {}).map((d) => `node_modules/${d}/`);

const FORBIDDEN = [
  { re: /^src\//, why: 'TypeScript sources belong in the repo, not the vsix' },
  { re: /\.test\.js$/, why: 'test files' },
  { re: /\.map$/, why: 'sourcemaps' },
  { re: /\.node$/, why: 'native binding — the vsix must stay platform-neutral' },
  { re: /^node_modules\/cpu-features\//, why: 'optional native dep of ssh2; the pure-JS path must be used' },
  { re: /^node_modules\/(nan|buildcheck)\//, why: 'build-only dependency of cpu-features, which is not shipped' },
  { re: /^node_modules\/ssh2\/lib\/protocol\/crypto\/build\//, why: 'native build output of ssh2' },
  { re: /^\.rcc-local\//, why: 'local pull cache' },
  { re: /^\.github\//, why: 'CI configuration' },
  { re: /^PLAN\.md$/, why: 'internal design document' },
  { re: /^RELEASE\.md$/, why: 'maintainer-only checklist' },
  { re: /^media\/icon-source\.html$/, why: 'icon build source' },
  { re: /^.*\.vsix$/, why: 'a previous package' },
  { re: /(^|\/)\.env/, why: 'environment file — may hold credentials' }
];

// Build tooling that must never be mistaken for a runtime dependency.
const FORBIDDEN_DIRS = Object.keys(pkg.devDependencies || {})
  .filter((d) => !d.startsWith('@types/'))
  .map((d) => `node_modules/${d}/`);

function listPackagedFiles() {
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

const files = listPackagedFiles();
const problems = [];

for (const required of REQUIRED) {
  if (!files.includes(required)) {
    problems.push(`missing: ${required}`);
  }
}

for (const dir of REQUIRED_DIRS) {
  if (!files.some((f) => f.startsWith(dir))) {
    problems.push(`runtime dependency not packaged: ${dir}`);
  }
}

for (const { re, why } of FORBIDDEN) {
  const hits = files.filter((f) => re.test(f));
  if (hits.length) {
    problems.push(`must not ship (${why}): ${hits.slice(0, 5).join(', ')}${hits.length > 5 ? ` … +${hits.length - 5}` : ''}`);
  }
}

for (const dir of FORBIDDEN_DIRS) {
  if (files.some((f) => f.startsWith(dir))) {
    problems.push(`devDependency packaged as runtime: ${dir}`);
  }
}

// The icon has to be a PNG: the Marketplace rejects SVG.
if (pkg.icon && !pkg.icon.toLowerCase().endsWith('.png')) {
  problems.push(`icon must be a .png for the Marketplace, got ${pkg.icon}`);
}

// Fields the Marketplace listing needs to look like a real extension.
for (const field of ['displayName', 'description', 'publisher', 'version', 'license', 'categories', 'keywords']) {
  if (!pkg[field] || (Array.isArray(pkg[field]) && pkg[field].length === 0)) {
    problems.push(`package.json is missing "${field}"`);
  }
}

const deps = files.filter((f) => f.startsWith('node_modules/')).length;
console.log(`vsce ls: ${files.length} files (${deps} from node_modules), ${files.length - deps} own`);

if (problems.length) {
  console.error('\nverify-package FAILED:');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}

console.log('verify-package OK');
