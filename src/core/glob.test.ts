import { test } from 'node:test';
import * as assert from 'node:assert';
import { matchesAnyGlob } from './glob';

test('matchesAnyGlob default excludes', () => {
  const globs = ['**/wp-content/cache/**', '**/node_modules/**', '**/.git/**'];
  assert.strictEqual(matchesAnyGlob('/public_html/wp-content/cache/page.html', globs), true);
  assert.strictEqual(matchesAnyGlob('/wp-content/cache/x/y.php', globs), true);
  assert.strictEqual(matchesAnyGlob('/public_html/wp-content/themes/index.php', globs), false);
  assert.strictEqual(matchesAnyGlob('/site/node_modules/pkg/index.js', globs), true);
  assert.strictEqual(matchesAnyGlob('/site/.git/config', globs), true);
  assert.strictEqual(matchesAnyGlob('/site/index.php', globs), false);
});

test('single star does not cross directories', () => {
  assert.strictEqual(matchesAnyGlob('/logs/app.log', ['*.log']), false);
  assert.strictEqual(matchesAnyGlob('/app.log', ['*.log']), true);
  assert.strictEqual(matchesAnyGlob('/logs/app.log', ['**/*.log']), true);
});
