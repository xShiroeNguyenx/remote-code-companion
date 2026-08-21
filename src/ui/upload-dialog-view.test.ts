import { test } from 'node:test';
import * as assert from 'node:assert';
import { DialogTarget, formatBytes, renderUploadDialog, splitRemotePath, UploadDialogModel } from './upload-dialog-view';

const target = (over: Partial<DialogTarget> = {}): DialogTarget => ({
  remotePath: '/home/techdeco/public_html/wp-content/plugins/custom/custom.php',
  fileName: 'custom.php',
  size: 12_680,
  serverSize: 12_100,
  delta: { added: 18, removed: 4 },
  created: false,
  critical: false,
  ...over
});

const model = (over: Partial<UploadDialogModel> = {}): UploadDialogModel => ({
  profileName: 'Tech',
  host: 'techdecoded.net',
  protocolLabel: 'SFTP (SSH)',
  targets: [target()],
  facts: [{ kind: 'ok', text: 'Server copy backed up' }],
  canDiff: true,
  ...over
});

test('formatBytes stays readable at every scale', () => {
  assert.strictEqual(formatBytes(512), '512 B');
  assert.strictEqual(formatBytes(2048), '2.0 KB');
  assert.strictEqual(formatBytes(120 * 1024), '120 KB');
  assert.strictEqual(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('splitRemotePath separates the directory from the file', () => {
  assert.deepStrictEqual(splitRemotePath('/a/b/c.php'), { dir: '/a/b/', name: 'c.php' });
  assert.deepStrictEqual(splitRemotePath('c.php'), { dir: '', name: 'c.php' });
});

test('the dialog states the server, the file and the change', () => {
  const html = renderUploadDialog(model(), 'NONCE1');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /script-src 'nonce-NONCE1'/);
  assert.match(html, /<script nonce="NONCE1">/);
  assert.match(html, /Upload to <em>Tech<\/em>/);
  assert.match(html, /techdecoded\.net/);
  assert.match(html, /SFTP \(SSH\)/);
  // The full path must be present, not an ellipsised version of it. The
  // directory is dimmed in its own span, so the name follows the closing tag.
  assert.match(html, /\/home\/techdeco\/public_html\/wp-content\/plugins\/custom\/<\/span>custom\.php/);
  assert.match(html, /\+18/);
  assert.match(html, /−4/);
  assert.match(html, /replaces 12 KB/);
  assert.match(html, /id="upload"/);
  assert.match(html, /id="cancel"/);
  assert.match(html, /id="diff"/);
  assert.ok(!/id="suppress"/.test(html), 'no checkbox without a label for it');
});

test('a file name cannot inject markup', () => {
  const html = renderUploadDialog(
    model({
      profileName: '<img src=x onerror=alert(1)>',
      targets: [target({ fileName: '</script><b>x</b>.php', remotePath: '/a/</script>.php' })]
    }),
    'N'
  );
  assert.ok(!html.includes('<img src=x'), 'the profile name must be escaped');
  assert.ok(!html.includes('</script><b>'), 'the file name must be escaped');
  assert.match(html, /&lt;\/script&gt;/);
});

test('a warning makes the dialog visibly risky and offers no way to silence it', () => {
  const html = renderUploadDialog(
    model({
      facts: [{ kind: 'warn', text: 'Changed on the server since you opened it' }],
      suppressLabel: undefined
    }),
    'N'
  );
  assert.match(html, /class="card risky"/);
  assert.match(html, /Changed on the server since you opened it/);
  assert.ok(!/id="suppress"/.test(html));
});

test('the suppress checkbox appears only with a label', () => {
  const html = renderUploadDialog(model({ suppressLabel: 'Stop asking for this remote' }), 'N');
  assert.match(html, /id="suppress"/);
  assert.match(html, /Stop asking for this remote/);
});

test('a new file is announced as a creation, without a replaced size', () => {
  const html = renderUploadDialog(
    model({ targets: [target({ created: true, serverSize: undefined, delta: undefined })] }),
    'N'
  );
  assert.match(html, /new file on the server/);
  assert.ok(!/replaces/.test(html));
});

test('many files render as a list with a counted button and no diff', () => {
  const html = renderUploadDialog(
    model({
      canDiff: false,
      targets: [
        target({ remotePath: '/a/one.php', fileName: 'one.php', size: 1024 }),
        target({ remotePath: '/a/two.css', fileName: 'two.css', size: 2048, created: true }),
        target({ remotePath: '/a/wp-config.php', fileName: 'wp-config.php', critical: true })
      ]
    }),
    'N'
  );
  assert.match(html, /3 files/);
  assert.match(html, /Upload 3 Files/);
  assert.match(html, /\/a\/wp-config\.php/);
  assert.match(html, /class="critical"/);
  assert.ok(!/id="diff"/.test(html), 'a batch has no single subject to diff');
});
