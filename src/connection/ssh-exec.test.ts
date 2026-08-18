import { execFileSync } from 'node:child_process';
import * as assert from 'node:assert';
import { test } from 'node:test';
import { shellQuote } from './ssh-exec';

/**
 * The remote dump command is assembled as a shell string, and a WordPress database
 * password can contain anything. Getting this wrong would either break the dump or,
 * worse, let a password terminate the quoting and change the command that runs on
 * the production server.
 */

test('wraps ordinary values in single quotes', () => {
  assert.strictEqual(shellQuote('simple'), "'simple'");
  assert.strictEqual(shellQuote('wp_db_name'), "'wp_db_name'");
});

test('neutralises the characters a shell would act on', () => {
  for (const value of ['a b', 'a$b', 'a`b`', 'a;rm -rf /', 'a&&b', 'a|b', 'a>b', 'a\\b', 'a*b', 'a#b']) {
    const quoted = shellQuote(value);
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), value);
    // Nothing inside may be an unescaped quote, which is the only way out.
    assert.strictEqual(quoted.slice(1, -1).includes("'"), false, `unescaped quote for ${value}`);
  }
});

test('escapes embedded single quotes so the value cannot end the argument', () => {
  assert.strictEqual(shellQuote("it's"), "'it'\\''s'");
  // The classic injection attempt: close the quote and append a command.
  const hostile = "x'; echo pwned; '";
  const quoted = shellQuote(hostile);
  assert.ok(!/'\s*;\s*echo/.test(quoted.replace(/'\\''/g, '')), 'the payload must stay inside the quotes');
});

test('a quoted value survives a real shell round-trip', (t) => {
  if (process.platform === 'win32') {
    // No POSIX shell to verify against; the escaping rules above still hold.
    t.skip('needs a POSIX shell');
    return;
  }
  for (const value of ["p@ss'w0rd", 'a b$c`d`', "'; id; '", 'ünïcødé']) {
    const out = execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' });
    assert.strictEqual(out, value, `round-trip failed for ${value}`);
  }
});
