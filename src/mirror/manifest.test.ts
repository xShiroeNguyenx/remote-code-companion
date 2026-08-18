import * as assert from 'node:assert';
import { test } from 'node:test';
import {
  emptyManifest,
  localRelPathFor,
  parseManifest,
  remotePathFor,
  serializeManifest
} from './manifest';
import { SyncEntry } from './types';

function entry(remotePath: string, overrides: Partial<SyncEntry> = {}): SyncEntry {
  return {
    remotePath,
    localRelPath: remotePath.replace(/^\/public_html\//, ''),
    baseSha256: 'aaa',
    baseSize: 10,
    baseRemoteMtimeMs: 1000,
    baseMtimeSource: 'mdtm',
    pulledAt: 5,
    ...overrides
  };
}

test('maps remote paths to local relative paths under the root', () => {
  assert.strictEqual(localRelPathFor('/public_html', '/public_html/wp-content/x.php'), 'wp-content/x.php');
  assert.strictEqual(localRelPathFor('/', '/wp-content/x.php'), 'wp-content/x.php');
  assert.strictEqual(localRelPathFor('/public_html', '/public_html'), '');
});

test('refuses to map a path outside the root', () => {
  assert.strictEqual(localRelPathFor('/public_html', '/etc/passwd'), undefined);
  assert.strictEqual(localRelPathFor('/public_html', '/public_htmlx/a.php'), undefined);
});

test('round-trips remote and local paths, including Windows separators', () => {
  assert.strictEqual(remotePathFor('/public_html', 'wp-content/x.php'), '/public_html/wp-content/x.php');
  assert.strictEqual(remotePathFor('/public_html', 'wp-content\\themes\\a.css'), '/public_html/wp-content/themes/a.css');
  const remote = '/public_html/wp-content/themes/a.css';
  const rel = localRelPathFor('/public_html', remote) as string;
  assert.strictEqual(remotePathFor('/public_html', rel), remote);
});

test('round-trips a manifest through serialize and parse', () => {
  const manifest = emptyManifest('/public_html');
  manifest.entries['/public_html/a.php'] = entry('/public_html/a.php');
  const loaded = parseManifest(serializeManifest(manifest), '/public_html');
  assert.strictEqual(loaded.reset, false);
  assert.strictEqual(Object.keys(loaded.manifest.entries).length, 1);
  assert.strictEqual(loaded.manifest.entries['/public_html/a.php'].baseSha256, 'aaa');
});

test('discards the manifest when remoteRoot changed', () => {
  const manifest = emptyManifest('/public_html');
  manifest.entries['/public_html/a.php'] = entry('/public_html/a.php');
  const loaded = parseManifest(serializeManifest(manifest), '/other_root');
  assert.strictEqual(loaded.reset, true, 'baselines from a different root must not be reused');
  assert.match(String(loaded.resetReason), /remote root changed/);
  assert.deepStrictEqual(loaded.manifest.entries, {});
});

test('discards a manifest with an unsupported version', () => {
  const loaded = parseManifest(JSON.stringify({ version: 99, remoteRoot: '/', entries: {} }), '/');
  assert.strictEqual(loaded.reset, true);
  assert.match(String(loaded.resetReason), /version 99/);
});

test('discards unparseable manifests instead of throwing', () => {
  for (const raw of ['{ broken', '[]', 'null']) {
    const loaded = parseManifest(raw, '/');
    assert.strictEqual(loaded.reset, true, `${raw} should reset`);
    assert.deepStrictEqual(loaded.manifest.entries, {});
  }
});

test('drops entries that lack a usable baseline', () => {
  const raw = JSON.stringify({
    version: 1,
    remoteRoot: '/public_html',
    entries: {
      '/public_html/good.php': entry('/public_html/good.php'),
      '/public_html/no-hash.php': { remotePath: '/public_html/no-hash.php', baseSize: 3 },
      '/public_html/no-size.php': { remotePath: '/public_html/no-size.php', baseSha256: 'x' },
      '/public_html/not-an-object.php': 42
    }
  });
  const loaded = parseManifest(raw, '/public_html');
  assert.deepStrictEqual(Object.keys(loaded.manifest.entries), ['/public_html/good.php']);
  assert.strictEqual(loaded.reset, false, 'a bad entry must not discard the whole manifest');
});

test('drops entries pointing outside the root', () => {
  const raw = JSON.stringify({
    version: 1,
    remoteRoot: '/public_html',
    entries: { '/elsewhere/a.php': entry('/elsewhere/a.php', { localRelPath: 'a.php' }) }
  });
  assert.deepStrictEqual(parseManifest(raw, '/public_html').manifest.entries, {});
});

test('defaults an unknown mtime source to none rather than trusting it', () => {
  const raw = JSON.stringify({
    version: 1,
    remoteRoot: '/',
    entries: { '/a.php': { ...entry('/a.php'), remotePath: '/a.php', baseMtimeSource: 'guessed' } }
  });
  const loaded = parseManifest(raw, '/');
  assert.strictEqual(loaded.manifest.entries['/a.php'].baseMtimeSource, 'none');
});

test('serializes entries in sorted order', () => {
  const manifest = emptyManifest('/');
  manifest.entries['/b.php'] = entry('/b.php', { localRelPath: 'b.php' });
  manifest.entries['/a.php'] = entry('/a.php', { localRelPath: 'a.php' });
  const keys = Object.keys(JSON.parse(serializeManifest(manifest)).entries);
  assert.deepStrictEqual(keys, ['/a.php', '/b.php']);
});
