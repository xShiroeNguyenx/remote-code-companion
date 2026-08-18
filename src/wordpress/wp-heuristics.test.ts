import { test } from 'node:test';
import * as assert from 'node:assert';
import { isCriticalFile, suggestRootCandidates } from './wp-heuristics';

test('isCriticalFile', () => {
  assert.strictEqual(isCriticalFile('/public_html/wp-config.php'), true);
  assert.strictEqual(isCriticalFile('/public_html/.htaccess'), true);
  assert.strictEqual(isCriticalFile('/public_html/wp-content/index.php'), false);
  assert.strictEqual(isCriticalFile('/wp-config.php.bak'), false);
});

test('suggestRootCandidates', () => {
  assert.deepStrictEqual(suggestRootCandidates(['mail', 'public_html', 'logs']), ['public_html']);
  assert.deepStrictEqual(suggestRootCandidates(['www', 'htdocs']), ['www', 'htdocs']);
  assert.deepStrictEqual(suggestRootCandidates(['random']), []);
});
