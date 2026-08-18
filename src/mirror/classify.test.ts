import * as assert from 'node:assert';
import { test } from 'node:test';
import { classify } from './classify';
import { SideBase, SideLocal, SideRemote, SyncState } from './types';

const BASE: SideBase = { sha256: 'aaa', size: 100, mtimeMs: 1_000_000, mtimeSource: 'sftp' };

function local(sha?: string): SideLocal {
  return sha === undefined ? { exists: false } : { exists: true, sha256: sha };
}

function remote(overrides: Partial<SideRemote> = {}): SideRemote {
  return { exists: true, size: 100, mtimeMs: 1_000_000, mtimeSource: 'sftp', ...overrides };
}

function expectState(
  base: SideBase | undefined,
  l: SideLocal,
  r: SideRemote,
  expected: SyncState,
  message?: string
): void {
  const result = classify(base, l, r);
  assert.strictEqual(result.state, expected, `${message ?? ''} (reason was: ${result.reason})`);
}

// ---- the eight rows of the sync table, plus both-missing ----

test('unchanged on both sides is in sync', () => {
  expectState(BASE, local('aaa'), remote(), 'inSync');
});

test('edited locally only is pushable', () => {
  expectState(BASE, local('bbb'), remote(), 'localChanged');
});

test('changed on the server only should be pulled', () => {
  expectState(BASE, local('aaa'), remote({ size: 120, mtimeMs: 2_000_000 }), 'remoteChanged');
});

test('changed on both sides is a conflict', () => {
  expectState(BASE, local('bbb'), remote({ size: 120, mtimeMs: 2_000_000 }), 'bothChanged');
});

test('deleted locally, untouched on the server', () => {
  expectState(BASE, local(), remote(), 'localMissing');
});

test('deleted on the server, untouched locally', () => {
  expectState(BASE, local('aaa'), remote({ exists: false }), 'remoteMissing');
});

test('deleted on both sides', () => {
  expectState(BASE, local(), remote({ exists: false }), 'bothMissing');
});

test('new local file with no baseline is a creation', () => {
  expectState(undefined, local('ccc'), remote({ exists: false }), 'created');
});

test('new local file that already exists remotely is a conflict', () => {
  expectState(undefined, local('ccc'), remote(), 'createdBoth');
});

// ---- the dangerous asymmetric cases ----

test('edited locally but deleted on the server is a conflict, never a plain push', () => {
  const result = classify(BASE, local('bbb'), remote({ exists: false }));
  assert.strictEqual(result.state, 'bothChanged');
  assert.match(result.reason, /deleted on the server/);
});

test('deleted locally but changed on the server is a conflict, never a plain delete', () => {
  const result = classify(BASE, local(), remote({ size: 120, mtimeMs: 2_000_000 }));
  assert.strictEqual(result.state, 'bothChanged');
  assert.match(result.reason, /deleted locally/);
});

// ---- hash beats metadata ----

test('a matching remote hash means unchanged even when size and mtime differ', () => {
  // Can happen when the server rewrites metadata; the bytes are what matter.
  expectState(BASE, local('aaa'), remote({ sha256: 'aaa', size: 999, mtimeMs: 9_000_000 }), 'inSync');
});

test('a differing remote hash means changed even when size and mtime match', () => {
  expectState(BASE, local('aaa'), remote({ sha256: 'zzz' }), 'remoteChanged');
});

test('hash-based verdicts are never reported as degraded', () => {
  const result = classify(BASE, local('bbb'), remote({ sha256: 'zzz' }));
  assert.strictEqual(result.state, 'bothChanged');
  assert.strictEqual(result.degraded, false);
});

// ---- untrustworthy FTP metadata ----

test('same size with no mtime anywhere is treated as unchanged, but flagged degraded', () => {
  const base: SideBase = { sha256: 'aaa', size: 100, mtimeSource: 'none' };
  const result = classify(base, local('bbb'), { exists: true, size: 100, mtimeSource: 'none' });
  assert.strictEqual(result.state, 'localChanged', 'a size-only match must not invent a remote change');
  assert.strictEqual(result.degraded, true, 'the weak evidence must be reported');
});

test('a size change is a remote change even with no mtime at all', () => {
  const base: SideBase = { sha256: 'aaa', size: 100, mtimeSource: 'none' };
  expectState(base, local('aaa'), { exists: true, size: 101, mtimeSource: 'none' }, 'remoteChanged');
});

test('minute-granularity listing dates tolerate small drift', () => {
  const base: SideBase = { sha256: 'aaa', size: 100, mtimeMs: 1_000_000, mtimeSource: 'listing' };
  const result = classify(base, local('aaa'), {
    exists: true,
    size: 100,
    mtimeMs: 1_060_000, // one minute apart: within LIST granularity
    mtimeSource: 'listing'
  });
  assert.strictEqual(result.state, 'inSync');
  assert.strictEqual(result.degraded, true);
});

test('listing dates far apart still count as a remote change', () => {
  const base: SideBase = { sha256: 'aaa', size: 100, mtimeMs: 1_000_000, mtimeSource: 'listing' };
  expectState(
    base,
    local('aaa'),
    { exists: true, size: 100, mtimeMs: 1_600_000, mtimeSource: 'listing' },
    'remoteChanged'
  );
});

test('a local edit is detected by hash even when the server metadata is useless', () => {
  const base: SideBase = { sha256: 'aaa', size: 100, mtimeSource: 'none' };
  expectState(base, local('different'), { exists: true, size: 100, mtimeSource: 'none' }, 'localChanged');
});
