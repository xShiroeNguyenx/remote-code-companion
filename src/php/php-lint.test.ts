import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { nullLogger } from '../core/logger';
import { isPhpFile, lintPhpFiles, parseLintOutput } from './php-lint';
import { findPhp, parsePhpVersion } from './php-runtime';

test('reports nothing for a clean file', () => {
  assert.strictEqual(parseLintOutput('No syntax errors detected in C:\\x\\a.php', 'a.php'), undefined);
  assert.strictEqual(parseLintOutput('   ', 'a.php'), undefined);
});

test('extracts message and line from a parse error', () => {
  const output = [
    '',
    'Parse error: syntax error, unexpected token "{", expecting variable in C:\\tmp\\bad.php on line 2',
    'Errors parsing C:\\tmp\\bad.php'
  ].join('\n');
  const problem = parseLintOutput(output, 'wp-content/themes/z/bad.php');
  assert.ok(problem);
  assert.strictEqual(problem.line, 2);
  assert.strictEqual(problem.file, 'wp-content/themes/z/bad.php', 'the label is kept, not the temp path');
  assert.match(problem.message, /unexpected token/);
  assert.ok(!problem.message.includes('C:'), 'the local path does not belong in the message');
});

test('handles CRLF output', () => {
  const problem = parseLintOutput('Parse error: unexpected end of file in C:\\a.php on line 9\r\n', 'a.php');
  assert.ok(problem);
  assert.strictEqual(problem.line, 9);
});

test('handles a fatal error without a line number', () => {
  const problem = parseLintOutput('Fatal error: Cannot redeclare foo()', 'a.php');
  assert.ok(problem);
  assert.strictEqual(problem.line, undefined);
  assert.match(problem.message, /Cannot redeclare/);
});

test('does not silently pass output it cannot parse but that says parsing failed', () => {
  const problem = parseLintOutput('Errors parsing C:\\a.php', 'a.php');
  assert.ok(problem, 'an unattributable failure must still be reported');
});

test('ignores startup warnings that are not parse failures', () => {
  // A broken php.ini prints these; they must not read as syntax errors.
  const output = [
    "PHP Warning:  PHP Startup: Unable to load dynamic library 'curl' in Unknown on line 0",
    'No syntax errors detected in C:\\a.php'
  ].join('\n');
  assert.strictEqual(parseLintOutput(output, 'a.php'), undefined);
});

test('recognises the file types worth linting', () => {
  for (const name of ['a.php', 'functions.PHP', 'tpl.phtml', 'legacy.inc']) {
    assert.strictEqual(isPhpFile(name), true, name);
  }
  for (const name of ['style.css', 'app.js', 'readme.txt', 'a.php.bak']) {
    assert.strictEqual(isPhpFile(name), false, name);
  }
});

test('parses the PHP version banner', () => {
  assert.strictEqual(parsePhpVersion('PHP 8.2.29 (cli) (built: Jul  1 2025)'), '8.2.29');
  assert.strictEqual(parsePhpVersion('PHP 7.4.33 (cli)'), '7.4.33');
  assert.strictEqual(parsePhpVersion('bash: php: command not found'), undefined);
});

// End-to-end against the real PHP binary. Skipped where there is no PHP, so the
// suite still passes in a bare CI container.
test('lints real files with the PHP on this machine', async (t) => {
  const runtime = await findPhp(undefined, nullLogger);
  if (!runtime) {
    t.skip('no PHP available on this machine');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-lint-'));
  try {
    const good = path.join(dir, 'good.php');
    const bad = path.join(dir, 'bad.php');
    fs.writeFileSync(good, '<?php function ok() { return 1; }\n');
    fs.writeFileSync(bad, '<?php function bad( { return 1; }\n');

    const problems = await lintPhpFiles(runtime, [
      { localPath: good, label: 'themes/z/good.php' },
      { localPath: bad, label: 'themes/z/bad.php' }
    ]);

    assert.strictEqual(problems.length, 1, JSON.stringify(problems));
    assert.strictEqual(problems[0].file, 'themes/z/bad.php');
    assert.strictEqual(problems[0].line, 1, 'the reported line should be where the error is');
    assert.match(problems[0].message, /syntax error/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
