export type RccErrorCode =
  | 'FileNotFound'
  | 'FileExists'
  | 'NoPermissions'
  | 'Unavailable'
  | 'Cancelled'
  | 'TooLarge'
  | 'ConnectionFailed';

export class RccError extends Error {
  constructor(public readonly code: RccErrorCode, message: string) {
    super(message);
    this.name = 'RccError';
  }
}

const CONNECTION_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND'
]);

const CONNECTION_ERROR_PATTERNS = [
  'client is closed',
  'connection closed',
  'connection lost',
  'connection ended',
  'not connected',
  'no sftp connection',
  'timed out',
  'timeout while',
  'socket hang up',
  'this socket has been ended',
  'econnreset'
];

/**
 * A passive data connection could not be opened. This is NOT the control
 * connection dying: the command channel is usually fine, and the server will
 * hand out a different passive port on the next attempt. Treating it as a dead
 * connection would tear down and re-open the control connection, which on a
 * shared host is how you get the IP blocked by connection-flood protection.
 */
const DATA_CONNECTION_PATTERNS = ["can't open data connection", 'transfer strategies', 'data connection'];

export function isDataConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const message = typeof (err as { message?: unknown }).message === 'string'
    ? (err as { message: string }).message.toLowerCase()
    : '';
  return DATA_CONNECTION_PATTERNS.some((p) => message.includes(p));
}

/**
 * Heuristic: does this error mean the underlying connection is dead
 * (so a reconnect + single replay is worth attempting)?
 */
export function isConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const anyErr = err as { code?: unknown; name?: unknown; message?: unknown };
  if (typeof anyErr.code === 'string' && CONNECTION_ERROR_CODES.has(anyErr.code)) {
    return true;
  }
  // basic-ftp FTPError: numeric code, 421 = service closing control connection
  if (anyErr.name === 'FTPError' && anyErr.code === 421) {
    return true;
  }
  const message = typeof anyErr.message === 'string' ? anyErr.message.toLowerCase() : '';
  return CONNECTION_ERROR_PATTERNS.some((p) => message.includes(p));
}

/**
 * Is the connection unusable *right now*? Broader than isConnectionError: it also
 * covers "we tried to reconnect and could not". Batch operations use this to stop
 * immediately — retrying a thousand more files against a dead connection just
 * turns one clear failure into a very long hang.
 *
 * Deliberately NOT folded into isConnectionError, which decides whether a
 * reconnect-and-replay is worth attempting; after a failed connect, it is not.
 */
export function isConnectionFailure(err: unknown): boolean {
  if (err instanceof RccError && err.code === 'ConnectionFailed') {
    return true;
  }
  return isConnectionError(err);
}
