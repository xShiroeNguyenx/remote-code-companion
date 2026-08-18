import { test } from 'node:test';
import * as assert from 'node:assert';
import { detectConflict } from './conflict-detector';

const T = 1_750_000_000_000;

test('precise sources: mtime shift is a conflict', () => {
  const v = detectConflict(
    { mtimeMs: T, size: 100, mtimeSource: 'sftp' },
    { mtimeMs: T + 60_000, size: 100, mtimeSource: 'sftp' }
  );
  assert.strictEqual(v.conflict, true);
  assert.strictEqual(v.degraded, false);
});

test('precise sources: sub-2s rounding is not a conflict', () => {
  const v = detectConflict(
    { mtimeMs: T, size: 100, mtimeSource: 'mdtm' },
    { mtimeMs: T + 1000, size: 100, mtimeSource: 'mdtm' }
  );
  assert.strictEqual(v.conflict, false);
});

test('size change always conflicts, even without mtimes', () => {
  const v = detectConflict(
    { mtimeMs: undefined, size: 100, mtimeSource: 'none' },
    { mtimeMs: undefined, size: 250, mtimeSource: 'none' }
  );
  assert.strictEqual(v.conflict, true);
  assert.strictEqual(v.degraded, true);
});

test('listing granularity tolerates two minutes', () => {
  const ok = detectConflict(
    { mtimeMs: T, size: 100, mtimeSource: 'listing' },
    { mtimeMs: T + 110_000, size: 100, mtimeSource: 'listing' }
  );
  assert.strictEqual(ok.conflict, false);
  const bad = detectConflict(
    { mtimeMs: T, size: 100, mtimeSource: 'listing' },
    { mtimeMs: T + 200_000, size: 100, mtimeSource: 'listing' }
  );
  assert.strictEqual(bad.conflict, true);
});

test('mixed precision uses the weaker side', () => {
  const v = detectConflict(
    { mtimeMs: T, size: 100, mtimeSource: 'sftp' },
    { mtimeMs: T + 90_000, size: 100, mtimeSource: 'listing' }
  );
  // listing tolerance (120s) applies → not a conflict
  assert.strictEqual(v.conflict, false);
});
