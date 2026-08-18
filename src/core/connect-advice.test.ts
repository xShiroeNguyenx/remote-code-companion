import * as assert from 'node:assert';
import { test } from 'node:test';
import {
  authFailureAdvice,
  isAuthFailure,
  isPathNotFound,
  parseCertMismatch,
  remapRoots,
  suggestRemoteRoot
} from './connect-advice';

test('extracts the certificate host names from a Node TLS mismatch', () => {
  const message =
    "Hostname/IP does not match certificate's altnames: Host: techdecoded.net. is not in the cert's altnames: DNS:dal220.arandomserver.com, DNS:dal220.hawkhost.com";
  assert.deepStrictEqual(parseCertMismatch(message), ['dal220.arandomserver.com', 'dal220.hawkhost.com']);
});

test('handles a single altname and a trailing period', () => {
  const message = "Hostname/IP does not match certificate's altnames: ... cert's altnames: DNS:server.example.com.";
  assert.deepStrictEqual(parseCertMismatch(message), ['server.example.com']);
});

test('handles IP entries alongside DNS entries', () => {
  const message = "does not match certificate's altnames: DNS:a.example.com, IP Address:203.0.113.5";
  const names = parseCertMismatch(message);
  assert.ok(names);
  assert.ok(names.includes('a.example.com'));
});

test('returns undefined for unrelated connection errors', () => {
  for (const message of [
    'connect ETIMEDOUT 198.252.104.170:21 (control socket)',
    '530 Login authentication failed',
    "Can't open data connection in passive mode",
    ''
  ]) {
    assert.strictEqual(parseCertMismatch(message), undefined, `should ignore: ${message}`);
  }
});

test('returns undefined when the message mentions a certificate but lists no names', () => {
  assert.strictEqual(parseCertMismatch('self signed certificate in certificate chain'), undefined);
  assert.strictEqual(parseCertMismatch('unable to verify the first certificate'), undefined);
});

test('recognises auth failures from both SSH and FTP wording', () => {
  for (const message of [
    'connect: getConnection: All configured authentication methods failed',
    '530 Login authentication failed',
    'Permission denied (publickey,password)'
  ]) {
    assert.strictEqual(isAuthFailure(message), true, message);
  }
  assert.strictEqual(isAuthFailure('connect ETIMEDOUT 1.2.3.4:21'), false);
});

test('tells an SFTP user that a cPanel FTP sub-account name cannot work', () => {
  const notes = authFailureAdvice({
    protocol: 'sftp',
    username: 'techdeco@techdecoded.net',
    auth: 'password'
  });
  assert.match(notes[0], /sub-account/);
  // The suggestion must be the bare account, which is the actually usable name.
  assert.match(notes[0], /"techdeco"/);
  assert.ok(!notes[0].includes('"techdeco@'), 'must not suggest the domain form again');
});

test('mentions key-only hosts when SFTP is using a password', () => {
  const notes = authFailureAdvice({ protocol: 'sftp', username: 'techdeco', auth: 'password' });
  assert.ok(
    notes.some((n) => /keys only/i.test(n)),
    'password auth on sftp should mention key-only hosts'
  );
  assert.ok(!notes.some((n) => /sub-account/.test(n)), 'a bare username is not a sub-account problem');
});

test('does not repeat the key advice when a key is already configured', () => {
  const notes = authFailureAdvice({ protocol: 'sftp', username: 'techdeco', auth: 'privateKey' });
  assert.ok(!notes.some((n) => /keys only/i.test(n)));
});

test('gives FTP the mirror-image advice about the domain suffix', () => {
  const withoutDomain = authFailureAdvice({ protocol: 'ftp', username: 'techdeco', auth: 'password' });
  assert.ok(withoutDomain.some((n) => /user@domain/.test(n)));

  const withDomain = authFailureAdvice({
    protocol: 'ftp',
    username: 'techdeco@techdecoded.net',
    auth: 'password'
  });
  assert.ok(!withDomain.some((n) => /user@domain/.test(n)), "the suffix is already there");
});

test('recognises a missing path from SFTP and FTP wording', () => {
  assert.strictEqual(isPathNotFound('list: No such file /public_html'), true);
  assert.strictEqual(isPathNotFound('550 Directory not found'), true);
  assert.strictEqual(isPathNotFound('connect ETIMEDOUT'), false);
});

test('turns a chrooted FTP path into the absolute path SSH needs', () => {
  assert.strictEqual(
    suggestRemoteRoot({ protocol: 'sftp', username: 'techdeco', remoteRoot: '/public_html' }),
    '/home/techdeco/public_html'
  );
  // The account name is the part before @, so a leftover FTP username still works.
  assert.strictEqual(
    suggestRemoteRoot({ protocol: 'sftp', username: 'techdeco@techdecoded.net', remoteRoot: '/public_html' }),
    '/home/techdeco/public_html'
  );
  assert.strictEqual(
    suggestRemoteRoot({ protocol: 'sftp', username: 'techdeco', remoteRoot: '/' }),
    '/home/techdeco'
  );
});

test('suggests nothing when the SFTP path is already home-absolute', () => {
  assert.strictEqual(
    suggestRemoteRoot({ protocol: 'sftp', username: 'techdeco', remoteRoot: '/home/techdeco/public_html' }),
    undefined
  );
  assert.strictEqual(
    suggestRemoteRoot({ protocol: 'sftp', username: 'techdeco', remoteRoot: '/home/techdeco' }),
    undefined
  );
});

test('strips the home prefix for FTP, which is usually chrooted', () => {
  assert.strictEqual(
    suggestRemoteRoot({ protocol: 'ftp', username: 'techdeco', remoteRoot: '/home/techdeco/public_html' }),
    '/public_html'
  );
  assert.strictEqual(
    suggestRemoteRoot({ protocol: 'ftp', username: 'techdeco', remoteRoot: '/public_html' }),
    undefined
  );
});

test('remaps synced subtrees onto a new root', () => {
  assert.deepStrictEqual(
    remapRoots(['/public_html/wp-content/themes/zosia'], '/public_html', '/home/techdeco/public_html'),
    ['/home/techdeco/public_html/wp-content/themes/zosia']
  );
  // The root itself moves too.
  assert.deepStrictEqual(remapRoots(['/public_html'], '/public_html', '/home/x/public_html'), ['/home/x/public_html']);
});

test('leaves subtrees outside the old root untouched', () => {
  assert.deepStrictEqual(
    remapRoots(['/elsewhere/a', '/public_html/b'], '/public_html', '/home/x/public_html'),
    ['/elsewhere/a', '/home/x/public_html/b']
  );
  assert.deepStrictEqual(remapRoots(['/public_htmlx/a'], '/public_html', '/home/x'), ['/public_htmlx/a']);
});

test('remapping from the filesystem root prefixes every subtree', () => {
  assert.deepStrictEqual(remapRoots(['/wp-content/themes/a'], '/', '/home/x'), ['/home/x/wp-content/themes/a']);
});

test('remapping is a no-op when the root did not change', () => {
  const roots = ['/public_html/a'];
  assert.strictEqual(remapRoots(roots, '/public_html', '/public_html'), roots);
});
