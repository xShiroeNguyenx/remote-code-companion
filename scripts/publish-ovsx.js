'use strict';
// Publish the already-built vsix to Open VSX — the registry VSCodium, Gitpod and
// Eclipse Theia install from, since they cannot use the Microsoft Marketplace.
//
// The same artifact is published to both registries. Building a second one would
// mean shipping bytes nobody verified.
//
// Requires OVSX_PAT, and a namespace matching `publisher` in package.json. See
// RELEASE.md for how to obtain both.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vsix = `remote-code-companion-${pkg.version}.vsix`;

function fail(message, hint) {
  console.error('\n  error: ' + message);
  if (hint) {
    console.error('  ' + hint);
  }
  console.error('');
  process.exit(1);
}

if (!process.env.OVSX_PAT) {
  fail(
    'OVSX_PAT is not set.',
    'Create a token at https://open-vsx.org/user-settings/tokens (sign in with GitHub, ' +
      'and sign the Publisher Agreement first), then set OVSX_PAT.'
  );
}

if (!fs.existsSync(path.join(process.cwd(), vsix))) {
  fail(`${vsix} not found.`, 'Run `npm run package` first — the same artifact goes to both registries.');
}

// The token is passed through the environment, not as an argument: arguments are
// visible in the process list.
const result = spawnSync('npx', ['ovsx', 'publish', '--packagePath', vsix], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if ((result.status ?? 1) !== 0) {
  fail(
    `ovsx publish exited with code ${result.status}.`,
    `If it says the namespace is unknown, create it once: npm run ovsx:namespace ` +
      `(the namespace must be "${pkg.publisher}", matching the publisher in package.json). ` +
      'If it says the version already exists, bump the version — a published version cannot be replaced.'
  );
}

console.log(`\n  published ${vsix} to Open VSX`);
console.log(`  https://open-vsx.org/extension/${pkg.publisher}/${pkg.name}\n`);
