import * as assert from 'node:assert';
import { test } from 'node:test';
import { parseWpConfig, splitDbHost } from './wp-config-parse';

const TYPICAL = [
  '<?php',
  '/** The name of the database for WordPress */',
  "define( 'DB_NAME', 'techdeco_wp' );",
  '',
  "/** MySQL database username */",
  "define( 'DB_USER', 'techdeco_user' );",
  '',
  "/** MySQL database password */",
  "define( 'DB_PASSWORD', 'p@ss:w0rd!#$' );",
  '',
  "define( 'DB_HOST', 'localhost' );",
  "define( 'DB_CHARSET', 'utf8mb4' );",
  "define( 'DB_COLLATE', '' );",
  '',
  "$table_prefix = 'wp_abc123_';",
  '',
  "define( 'WP_DEBUG', false );",
  "require_once ABSPATH . 'wp-settings.php';"
].join('\n');

test('reads credentials from a typical wp-config.php', () => {
  const result = parseWpConfig(TYPICAL);
  assert.deepStrictEqual(result.missing, []);
  assert.ok(result.config);
  assert.strictEqual(result.config.name, 'techdeco_wp');
  assert.strictEqual(result.config.user, 'techdeco_user');
  assert.strictEqual(result.config.password, 'p@ss:w0rd!#$', 'punctuation in passwords must survive');
  assert.strictEqual(result.config.host, 'localhost');
  assert.strictEqual(result.config.tablePrefix, 'wp_abc123_');
  assert.strictEqual(result.config.charset, 'utf8mb4');
});

test('handles double quotes and tight spacing', () => {
  const source = ['<?php', 'define("DB_NAME","db1");', "define('DB_USER',\"u1\");", 'define("DB_PASSWORD",\'pw\');'].join(
    '\n'
  );
  const result = parseWpConfig(source);
  assert.ok(result.config);
  assert.strictEqual(result.config.name, 'db1');
  assert.strictEqual(result.config.user, 'u1');
  assert.strictEqual(result.config.password, 'pw');
});

test('defaults the table prefix and host when absent', () => {
  const result = parseWpConfig(
    ['<?php', "define('DB_NAME','d');", "define('DB_USER','u');", "define('DB_PASSWORD','p');"].join('\n')
  );
  assert.ok(result.config);
  assert.strictEqual(result.config.tablePrefix, 'wp_', 'WordPress itself defaults to wp_');
  assert.strictEqual(result.config.host, 'localhost');
});

test('accepts an empty password, which some hosts really use', () => {
  const result = parseWpConfig(
    ['<?php', "define('DB_NAME','d');", "define('DB_USER','u');", "define('DB_PASSWORD','');"].join('\n')
  );
  assert.ok(result.config, 'an empty password is a value, not a missing field');
  assert.strictEqual(result.config.password, '');
});

test('reports exactly which defines are missing', () => {
  const result = parseWpConfig(['<?php', "define('DB_NAME','d');"].join('\n'));
  assert.strictEqual(result.config, undefined);
  assert.deepStrictEqual(result.missing, ['DB_USER', 'DB_PASSWORD']);
});

test('ignores commented-out defines', () => {
  // Hosts leave example blocks behind; picking those up would dump the wrong database.
  const source = [
    '<?php',
    '/*',
    "define('DB_NAME','example_db');",
    "define('DB_USER','example_user');",
    "define('DB_PASSWORD','example_pw');",
    '*/',
    "define('DB_NAME','real_db');",
    "define('DB_USER','real_user');",
    "define('DB_PASSWORD','real_pw');"
  ].join('\n');
  const result = parseWpConfig(source);
  assert.ok(result.config);
  assert.strictEqual(result.config.name, 'real_db');
  assert.strictEqual(result.config.user, 'real_user');
});

test('ignores line-commented defines', () => {
  const source = [
    '<?php',
    "// define('DB_NAME','old_db');",
    "#  define('DB_USER','old_user');",
    "define('DB_NAME','new_db');",
    "define('DB_USER','new_user');",
    "define('DB_PASSWORD','pw');"
  ].join('\n');
  const result = parseWpConfig(source);
  assert.ok(result.config);
  assert.strictEqual(result.config.name, 'new_db');
  assert.strictEqual(result.config.user, 'new_user');
});

test('returns nothing useful for a file that is not a wp-config', () => {
  const result = parseWpConfig('<?php echo "hello";');
  assert.strictEqual(result.config, undefined);
  assert.deepStrictEqual(result.missing, ['DB_NAME', 'DB_USER', 'DB_PASSWORD']);
});

test('splits host forms the way WordPress does', () => {
  assert.deepStrictEqual(splitDbHost('localhost'), { host: 'localhost' });
  assert.deepStrictEqual(splitDbHost('127.0.0.1:3307'), { host: '127.0.0.1', port: 3307 });
  assert.deepStrictEqual(splitDbHost('localhost:/var/run/mysqld/mysqld.sock'), {
    host: 'localhost',
    socket: '/var/run/mysqld/mysqld.sock'
  });
  assert.deepStrictEqual(splitDbHost('  db.internal  '), { host: 'db.internal' });
});
