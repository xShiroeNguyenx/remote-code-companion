import { test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nullLogger } from '../core/logger';
import { BackupManager } from './backup-manager';

function tmpBase(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-backup-test-'));
}

test('write + read + list round-trip', async () => {
  const base = tmpBase();
  const mgr = new BackupManager((id) => path.join(base, id), nullLogger, () => ({ maxPerFile: 10, maxAgeDays: 30 }));
  const entry = await mgr.write('ab12cd34', '/public_html/wp-config.php', Buffer.from('v1'), 'pre-save');
  assert.strictEqual(entry.size, 2);

  const listed = await mgr.listForFile('ab12cd34', '/public_html/wp-config.php');
  assert.strictEqual(listed.length, 1);
  assert.strictEqual((await mgr.read(listed[0])).toString(), 'v1');

  const latest = await mgr.latestFor('ab12cd34', '/public_html/wp-config.php');
  assert.strictEqual(latest?.id, entry.id);
  fs.rmSync(base, { recursive: true, force: true });
});

test('prunes to maxPerFile keeping newest', async () => {
  const base = tmpBase();
  const mgr = new BackupManager((id) => path.join(base, id), nullLogger, () => ({ maxPerFile: 3, maxAgeDays: 30 }));
  for (let i = 0; i < 6; i++) {
    await mgr.write('ab12cd34', '/site/index.php', Buffer.from(`v${i}`), 'pre-save');
  }
  const listed = await mgr.listForFile('ab12cd34', '/site/index.php');
  assert.strictEqual(listed.length, 3);
  assert.strictEqual((await mgr.read(listed[0])).toString(), 'v5');
  // pruned files are really gone from disk
  const dir = mgr.fileDir('ab12cd34', '/site/index.php');
  assert.strictEqual(fs.readdirSync(dir).length, 3);
  fs.rmSync(base, { recursive: true, force: true });
});

test('deleteEntry removes file and index row', async () => {
  const base = tmpBase();
  const mgr = new BackupManager((id) => path.join(base, id), nullLogger, () => ({ maxPerFile: 10, maxAgeDays: 30 }));
  const entry = await mgr.write('ab12cd34', '/a.txt', Buffer.from('x'), 'manual');
  await mgr.deleteEntry(entry);
  assert.strictEqual((await mgr.listAll('ab12cd34')).length, 0);
  assert.strictEqual(fs.existsSync(mgr.backupFilePath(entry)), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test('handles awkward remote names (spaces, unicode, dots)', async () => {
  const base = tmpBase();
  const mgr = new BackupManager((id) => path.join(base, id), nullLogger, () => ({ maxPerFile: 10, maxAgeDays: 30 }));
  const entry = await mgr.write('ab12cd34', '/tên tệp/.htaccess', Buffer.from('deny'), 'pre-delete');
  assert.strictEqual((await mgr.read(entry)).toString(), 'deny');
  fs.rmSync(base, { recursive: true, force: true });
});
