import { test } from 'node:test';
import * as assert from 'node:assert';
import { isConnectionError, RccError } from './errors';

test('recognizes connection-class errors', () => {
  const withCode = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  assert.strictEqual(isConnectionError(withCode), true);
  assert.strictEqual(isConnectionError(new Error('Client is closed')), true);
  assert.strictEqual(isConnectionError(new Error('Connection closed by server')), true);
  assert.strictEqual(isConnectionError(new Error('No SFTP connection available')), true);
  const ftp421 = Object.assign(new Error('421 Service closing'), { name: 'FTPError', code: 421 });
  assert.strictEqual(isConnectionError(ftp421), true);
});

test('does not flag ordinary errors', () => {
  assert.strictEqual(isConnectionError(new Error('550 No such file')), false);
  assert.strictEqual(isConnectionError(new RccError('FileNotFound', 'missing')), false);
  assert.strictEqual(isConnectionError(undefined), false);
  assert.strictEqual(isConnectionError('string error'), false);
});
