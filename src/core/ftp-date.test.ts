import { test } from 'node:test';
import * as assert from 'node:assert';
import { parseRawListDate } from './ftp-date';

test('unix LIST date with year', () => {
  const ms = parseRawListDate('Jan  3 2025');
  assert.ok(ms !== undefined);
  const d = new Date(ms as number);
  assert.strictEqual(d.getFullYear(), 2025);
  assert.strictEqual(d.getMonth(), 0);
  assert.strictEqual(d.getDate(), 3);
});

test('unix LIST date with time assumes current year, rolls back future dates', () => {
  const now = new Date(2026, 1, 1); // Feb 1 2026
  const ms = parseRawListDate('Dec 30 23:59', now);
  assert.ok(ms !== undefined);
  assert.strictEqual(new Date(ms as number).getFullYear(), 2025);

  const recent = parseRawListDate('Jan 15 08:00', now);
  assert.strictEqual(new Date(recent as number).getFullYear(), 2026);
});

test('DOS-style date', () => {
  const ms = parseRawListDate('04-27-26 09:09PM');
  assert.ok(ms !== undefined);
  const d = new Date(ms as number);
  assert.strictEqual(d.getFullYear(), 2026);
  assert.strictEqual(d.getMonth(), 3);
  assert.strictEqual(d.getDate(), 27);
  assert.strictEqual(d.getHours(), 21);
});

test('garbage returns undefined', () => {
  assert.strictEqual(parseRawListDate(undefined), undefined);
  assert.strictEqual(parseRawListDate(''), undefined);
  assert.strictEqual(parseRawListDate('not a date'), undefined);
});
