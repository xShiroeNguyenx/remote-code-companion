import * as assert from 'node:assert';
import { test } from 'node:test';
import { looksLikeSqlDump, sanitiseDump } from './dump-sanitise';

// The exact first line produced by MariaDB 10.11 on a real shared host, which an
// older client rejects with: ERROR at line 1: Unknown command '\-'.
const SANDBOX = String.raw`/*M!999999\- enable the sandbox mode */`;

const REAL_HEAD = [
  SANDBOX,
  '-- MariaDB dump 10.19  Distrib 10.11.18-MariaDB, for Linux (x86_64)',
  '--',
  '-- Host: localhost    Database: techdeco_database',
  '-- ------------------------------------------------------',
  '',
  'DROP TABLE IF EXISTS `wp_options`;',
  'CREATE TABLE `wp_options` (`option_id` bigint(20) unsigned NOT NULL);'
].join('\n');

test('removes the sandbox directive that breaks older clients', () => {
  const result = sanitiseDump(REAL_HEAD);
  assert.strictEqual(result.removed.length, 1);
  assert.strictEqual(result.removed[0], SANDBOX);
  assert.ok(!result.sql.includes('sandbox mode'));
  // Everything else must survive untouched, starting at the dump's own header.
  assert.ok(result.sql.startsWith('-- MariaDB dump'));
  assert.ok(result.sql.includes('CREATE TABLE `wp_options`'));
});

test('handles the MySQL variant and a trailing semicolon', () => {
  for (const line of [
    String.raw`/*!999999\- enable the sandbox mode */`,
    String.raw`/*M!999999\- enable the sandbox mode */;`,
    String.raw`  /*M!999999\- enable the sandbox mode */  `
  ]) {
    const result = sanitiseDump([line, 'CREATE TABLE t (id int);'].join('\n'));
    assert.strictEqual(result.removed.length, 1, line);
    assert.ok(result.sql.startsWith('CREATE TABLE'), line);
  }
});

test('leaves a dump without the directive completely alone', () => {
  const sql = ['-- MySQL dump 10.13', 'CREATE TABLE t (id int);'].join('\n');
  const result = sanitiseDump(sql);
  assert.deepStrictEqual(result.removed, []);
  assert.strictEqual(result.sql, sql, 'the original string should be returned unchanged');
});

test('does not touch conditional comments that carry real SQL', () => {
  // These matter: removing one would silently change the schema.
  const sql = [
    '/*!40101 SET @saved_cs_client = @@character_set_client */;',
    '/*M!100616 SET @save_ic = @@innodb_compression */;',
    'CREATE TABLE t (id int);'
  ].join('\n');
  const result = sanitiseDump(sql);
  assert.deepStrictEqual(result.removed, []);
  assert.strictEqual(result.sql, sql);
});

test('only looks at the top of the file', () => {
  // The same text inside data must not be rewritten.
  const sql = ['CREATE TABLE t (v text);', `INSERT INTO t VALUES ('${SANDBOX}');`].join('\n');
  const result = sanitiseDump(sql);
  assert.deepStrictEqual(result.removed, []);
  assert.ok(result.sql.includes(SANDBOX), 'data containing the directive stays intact');
});

test('recognises a real dump', () => {
  assert.deepStrictEqual(looksLikeSqlDump(REAL_HEAD), { ok: true });
  assert.strictEqual(looksLikeSqlDump('INSERT INTO `t` VALUES (1);').ok, true);
});

test('rejects an empty dump, which a failed pipeline leaves behind', () => {
  const verdict = looksLikeSqlDump('   \n  ');
  assert.strictEqual(verdict.ok, false);
  assert.match(String(verdict.reason), /empty/);
});

test('surfaces a mysqldump error that a pipeline exit code would hide', () => {
  // `mysqldump | gzip > file` returns gzip's status, so a failure arrives as a
  // valid gzip file containing an error message.
  const verdict = looksLikeSqlDump("mysqldump: Got error: 1045: Access denied for user 'x'@'localhost'");
  assert.strictEqual(verdict.ok, false);
  assert.match(String(verdict.reason), /Access denied/);
});

test('rejects content that is not a dump at all, quoting what it saw', () => {
  const verdict = looksLikeSqlDump('<html><body>404 Not Found</body></html>');
  assert.strictEqual(verdict.ok, false);
  assert.match(String(verdict.reason), /404 Not Found/);
});
