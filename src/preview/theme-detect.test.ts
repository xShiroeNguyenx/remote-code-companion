import * as assert from 'node:assert';
import { test } from 'node:test';
import { findPreviewTargets } from './theme-detect';

test('finds a theme from a synced subtree', () => {
  const targets = findPreviewTargets(['/public_html/wp-content/themes/zosia']);
  assert.deepStrictEqual(targets, [
    { kind: 'theme', name: 'zosia', remotePath: '/public_html/wp-content/themes/zosia' }
  ]);
});

test('works with the SFTP-style absolute root too', () => {
  const targets = findPreviewTargets(['/home/techdeco/public_html/wp-content/themes/zosia']);
  assert.strictEqual(targets.length, 1);
  assert.strictEqual(targets[0].name, 'zosia');
  assert.strictEqual(targets[0].remotePath, '/home/techdeco/public_html/wp-content/themes/zosia');
});

test('resolves a deeper path back to the theme itself', () => {
  // WordPress activates the theme, not the subdirectory being edited.
  const targets = findPreviewTargets(['/public_html/wp-content/themes/zosia/inc/blocks']);
  assert.deepStrictEqual(targets, [
    { kind: 'theme', name: 'zosia', remotePath: '/public_html/wp-content/themes/zosia' }
  ]);
});

test('finds plugins as well as themes', () => {
  const targets = findPreviewTargets([
    '/public_html/wp-content/themes/zosia',
    '/public_html/wp-content/plugins/my-plugin'
  ]);
  assert.deepStrictEqual(
    targets.map((t) => [t.kind, t.name]),
    [
      ['theme', 'zosia'],
      ['plugin', 'my-plugin']
    ]
  );
});

test('deduplicates several subtrees of the same theme', () => {
  const targets = findPreviewTargets([
    '/public_html/wp-content/themes/zosia/inc',
    '/public_html/wp-content/themes/zosia/assets'
  ]);
  assert.strictEqual(targets.length, 1);
});

test('ignores paths that are not a theme or plugin directory', () => {
  assert.deepStrictEqual(findPreviewTargets(['/public_html/wp-content/uploads/2024']), []);
  assert.deepStrictEqual(findPreviewTargets(['/public_html/wp-content/themes']), [], 'no theme name yet');
  assert.deepStrictEqual(findPreviewTargets(['/public_html']), []);
  assert.deepStrictEqual(findPreviewTargets(['/']), []);
  assert.deepStrictEqual(findPreviewTargets([]), []);
});

test('uses the last wp-content when a path oddly contains two', () => {
  const targets = findPreviewTargets(['/wp-content/backup/wp-content/themes/x']);
  assert.deepStrictEqual(targets, [{ kind: 'theme', name: 'x', remotePath: '/wp-content/backup/wp-content/themes/x' }]);
});
