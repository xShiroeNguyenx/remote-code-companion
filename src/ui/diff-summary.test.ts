import { test } from 'node:test';
import * as assert from 'node:assert';
import { changeSummary, isProbablyBinary, lineDelta } from './diff-summary';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

test('identical text has no delta', () => {
  assert.deepStrictEqual(lineDelta('a\nb\nc\n', 'a\nb\nc\n'), { added: 0, removed: 0 });
});

test('a trailing newline is a terminator, not an extra line', () => {
  assert.deepStrictEqual(lineDelta('a\nb', 'a\nb\n'), { added: 0, removed: 0 });
});

test('CRLF and LF describe the same file', () => {
  assert.deepStrictEqual(lineDelta('a\r\nb\r\n', 'a\nb\n'), { added: 0, removed: 0 });
});

test('pure insertion counts only additions', () => {
  assert.deepStrictEqual(lineDelta('a\nb\n', 'a\nnew1\nnew2\nb\n'), { added: 2, removed: 0 });
});

test('pure deletion counts only removals', () => {
  assert.deepStrictEqual(lineDelta('a\ngone\nb\n', 'a\nb\n'), { added: 0, removed: 1 });
});

test('an edited line is one added and one removed', () => {
  assert.deepStrictEqual(lineDelta('a\nold\nb\n', 'a\nnew\nb\n'), { added: 1, removed: 1 });
});

test('a moved block is not reported as a rewrite', () => {
  const before = 'head\nx\ny\nz\ntail\n';
  const after = 'head\nz\nx\ny\ntail\n';
  assert.deepStrictEqual(lineDelta(before, after), { added: 0, removed: 0 });
});

test('a new file is all additions', () => {
  assert.deepStrictEqual(lineDelta('', 'a\nb\n'), { added: 2, removed: 0 });
});

test('binary sniffing looks for NUL bytes', () => {
  assert.strictEqual(isProbablyBinary(encode('<?php echo 1;')), false);
  assert.strictEqual(isProbablyBinary(new Uint8Array([0x50, 0x4e, 0x47, 0x00, 0x01])), true);
});

test('changeSummary declines to guess without a server copy or on binary', () => {
  assert.strictEqual(changeSummary(undefined, encode('a\n')), undefined);
  assert.strictEqual(changeSummary(new Uint8Array([0, 1, 2]), encode('a\n')), undefined);
  assert.deepStrictEqual(changeSummary(encode('a\n'), encode('a\nb\n')), { added: 1, removed: 0 });
});
