import { test } from 'node:test';
import * as assert from 'node:assert';
import {
  basenameRemote,
  dirnameRemote,
  isWithinRemote,
  joinRemote,
  normalizeRemotePath
} from './remote-path';

test('normalizeRemotePath', () => {
  assert.strictEqual(normalizeRemotePath('/'), '/');
  assert.strictEqual(normalizeRemotePath(''), '/');
  assert.strictEqual(normalizeRemotePath('public_html'), '/public_html');
  assert.strictEqual(normalizeRemotePath('/public_html/'), '/public_html');
  assert.strictEqual(normalizeRemotePath('//a///b//'), '/a/b');
  assert.strictEqual(normalizeRemotePath('/a/./b/../c'), '/a/c');
  assert.strictEqual(normalizeRemotePath('public_html\\wp-content'), '/public_html/wp-content');
  assert.strictEqual(normalizeRemotePath('/tên tệp/日本語'), '/tên tệp/日本語');
});

test('joinRemote', () => {
  assert.strictEqual(joinRemote('/', 'a'), '/a');
  assert.strictEqual(joinRemote('/a', 'b', 'c.txt'), '/a/b/c.txt');
  assert.strictEqual(joinRemote('/a/', '/b/'), '/a/b');
});

test('dirnameRemote / basenameRemote', () => {
  assert.strictEqual(dirnameRemote('/a/b/c.txt'), '/a/b');
  assert.strictEqual(dirnameRemote('/a'), '/');
  assert.strictEqual(dirnameRemote('/'), '/');
  assert.strictEqual(basenameRemote('/a/b/c.txt'), 'c.txt');
  assert.strictEqual(basenameRemote('/'), '');
});

test('isWithinRemote', () => {
  assert.strictEqual(isWithinRemote('/', '/anything'), true);
  assert.strictEqual(isWithinRemote('/public_html', '/public_html/wp-config.php'), true);
  assert.strictEqual(isWithinRemote('/public_html', '/public_html'), true);
  assert.strictEqual(isWithinRemote('/public_html', '/public_html2/x'), false);
  assert.strictEqual(isWithinRemote('/public_html', '/etc/passwd'), false);
});
