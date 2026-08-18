import * as assert from 'node:assert';
import { test } from 'node:test';
import { CONFIG_VERSION, DEFAULT_MAX_FILE_SIZE_KB, configFromProfile, parseConfig, serializeConfig } from './config-file';
import { RemoteConfig, ServerProfile } from './types';

function profile(overrides: Partial<ServerProfile> = {}): ServerProfile {
  return {
    id: 'ab12cd34',
    name: 'Prod',
    protocol: 'ftp',
    host: 'example.com',
    port: 21,
    username: 'user@example.com',
    auth: 'password',
    remoteRoot: '/public_html',
    readOnly: false,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides
  };
}

function valid(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: CONFIG_VERSION,
    id: 'ab12cd34',
    name: 'Prod',
    protocol: 'ftp',
    host: 'example.com',
    port: 21,
    username: 'user@example.com',
    auth: 'password',
    remoteRoot: '/public_html',
    readOnly: false,
    roots: [],
    excludes: [],
    maxFileSizeKB: 512,
    ...overrides
  });
}

function expectError(raw: string, match: RegExp): void {
  const result = parseConfig(raw);
  assert.strictEqual(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, match);
  }
}

test('round-trips a config through serialize and parse', () => {
  const config = configFromProfile(profile());
  const result = parseConfig(serializeConfig(config));
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.config.id, 'ab12cd34');
    assert.strictEqual(result.config.host, 'example.com');
    assert.strictEqual(result.config.remoteRoot, '/public_html');
    assert.strictEqual(result.config.maxFileSizeKB, DEFAULT_MAX_FILE_SIZE_KB);
    assert.ok(result.config.excludes.includes('wp-admin'));
  }
});

test('serialized config never carries a secret', () => {
  const config: RemoteConfig = configFromProfile(profile({ auth: 'privateKey', protocol: 'sftp' }));
  const text = serializeConfig(config);
  assert.ok(!/password/i.test(text));
  assert.ok(!/passphrase/i.test(text));
});

test('refuses a config containing a password field', () => {
  expectError(valid({ password: 'hunter2' }), /secrets belong in the OS keychain/);
  expectError(valid({ passphrase: 'x' }), /secrets belong in the OS keychain/);
});

test('rejects a bad profile id', () => {
  expectError(valid({ id: 'NOTHEX!!' }), /8 lowercase hex/);
  expectError(valid({ id: 'ab12cd3' }), /8 lowercase hex/);
});

test('rejects unknown protocol and out-of-range port', () => {
  expectError(valid({ protocol: 'scp' }), /"protocol" must be one of/);
  expectError(valid({ port: 0 }), /"port" must be between/);
  expectError(valid({ port: 70000 }), /"port" must be between/);
});

test('rejects missing host or username', () => {
  expectError(valid({ host: '  ' }), /"host" is required/);
  expectError(valid({ username: '' }), /"username" is required/);
});

test('rejects a version it does not understand', () => {
  expectError(valid({ version: 99 }), /unsupported version 99/);
  expectError(JSON.stringify({ host: 'x' }), /unsupported version 0/);
});

test('rejects private-key auth on non-sftp protocols', () => {
  expectError(valid({ auth: 'privateKey', protocol: 'ftp' }), /only valid for the sftp protocol/);
});

test('rejects malformed JSON and non-objects', () => {
  expectError('{ nope', /invalid JSON/);
  expectError('[]', /expected a JSON object/);
  expectError('"a string"', /expected a JSON object/);
});

test('normalizes remoteRoot and sync roots, tolerating backslashes', () => {
  const result = parseConfig(
    valid({ remoteRoot: 'public_html/', roots: ['wp-content\\themes\\x', '/public_html/wp-content/plugins/y/'] })
  );
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.config.remoteRoot, '/public_html');
    assert.deepStrictEqual(result.config.roots, ['/wp-content/themes/x', '/public_html/wp-content/plugins/y']);
  }
});

test('falls back to defaults for absent optional fields', () => {
  const result = parseConfig(
    JSON.stringify({
      version: CONFIG_VERSION,
      id: 'ab12cd34',
      protocol: 'sftp',
      host: 'example.com',
      port: 22,
      username: 'me'
    })
  );
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.config.name, 'example.com', 'name falls back to host');
    assert.strictEqual(result.config.remoteRoot, '/');
    assert.strictEqual(result.config.readOnly, false);
    assert.strictEqual(result.config.maxFileSizeKB, DEFAULT_MAX_FILE_SIZE_KB);
    assert.deepStrictEqual(result.config.roots, []);
    assert.ok(result.config.excludes.length > 0, 'excludes fall back to the WordPress defaults');
  }
});

test('readOnly is only true when explicitly true', () => {
  for (const value of ['true', 1, null, undefined]) {
    const result = parseConfig(valid({ readOnly: value }));
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.config.readOnly, false, `readOnly should stay false for ${JSON.stringify(value)}`);
    }
  }
});

test('keeps per-config overrides distinct from absent ones', () => {
  const withOverride = parseConfig(valid({ confirmOnSave: false }));
  assert.strictEqual(withOverride.ok, true);
  if (withOverride.ok) {
    assert.strictEqual(withOverride.config.confirmOnSave, false);
  }
  const without = parseConfig(valid());
  assert.strictEqual(without.ok, true);
  if (without.ok) {
    assert.strictEqual(without.config.confirmOnSave, undefined, 'absent must stay undefined, not false');
  }
});
