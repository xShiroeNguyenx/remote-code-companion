import { test } from 'node:test';
import * as assert from 'node:assert';
import { isValidProfileId, makeRccParts, newProfileId, parseRccParts } from './rcc-uri';

test('newProfileId produces valid lowercase hex ids', () => {
  for (let i = 0; i < 20; i++) {
    const id = newProfileId();
    assert.strictEqual(isValidProfileId(id), true, id);
    assert.strictEqual(id, id.toLowerCase());
  }
});

test('makeRccParts + parseRccParts round-trips awkward paths', () => {
  const id = 'ab12cd34';
  const paths = [
    '/',
    '/public_html/wp-config.php',
    '/a b/c d.txt',
    '/percent %20 literal',
    '/hash#file?.php',
    '/tên tệp tiếng Việt.php',
    '/日本語/ファイル.txt',
    '/.htaccess'
  ];
  for (const p of paths) {
    const parts = makeRccParts(id, p);
    assert.strictEqual(parts.authority, id);
    const back = parseRccParts(parts);
    assert.strictEqual(back.profileId, id);
    assert.strictEqual(back.remotePath, p, `round-trip failed for ${p}`);
  }
});

test('parseRccParts tolerates uppercase authority (vscode lowercases it anyway)', () => {
  const back = parseRccParts({ authority: 'AB12CD34', path: '/x' });
  assert.strictEqual(back.profileId, 'ab12cd34');
});

test('parseRccParts rejects invalid authority', () => {
  assert.throws(() => parseRccParts({ authority: 'nope!', path: '/x' }));
  assert.throws(() => parseRccParts({ authority: '', path: '/x' }));
});
