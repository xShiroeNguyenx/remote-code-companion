'use strict';
// Runs all compiled *.test.js files (pure modules only — no vscode import) via node:test.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function collectTests(dir, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTests(full, found);
    } else if (entry.name.endsWith('.test.js')) {
      found.push(full);
    }
  }
}

const outDir = path.join(process.cwd(), 'out');
if (!fs.existsSync(outDir)) {
  console.error('out/ not found — run `npm run compile` first');
  process.exit(1);
}
const tests = [];
collectTests(outDir, tests);
if (tests.length === 0) {
  console.error('no compiled *.test.js files found');
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
