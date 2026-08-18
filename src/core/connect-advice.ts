/**
 * Shared hosts almost never hold a TLS certificate for the customer's own domain:
 * FTPS presents the certificate of the physical server (`dal220.example-host.com`)
 * while you connect as `yoursite.com`, and the handshake fails on the name.
 *
 * There are exactly two honest fixes, and a raw "does not match certificate's
 * altnames" message points at neither, so we detect the case and offer both.
 */

const ALTNAMES_MARKER = "altnames:";
const MISMATCH_HINT = 'does not match certificate';

/** Host names the server's certificate is actually valid for, if this is that error. */
export function parseCertMismatch(message: string): string[] | undefined {
  if (!message.toLowerCase().includes(MISMATCH_HINT)) {
    return undefined;
  }
  const at = message.lastIndexOf(ALTNAMES_MARKER);
  if (at === -1) {
    return undefined;
  }
  const names = message
    .slice(at + ALTNAMES_MARKER.length)
    .split(',')
    .map((part) => part.trim())
    .map((part) => (part.toUpperCase().startsWith('DNS:') ? part.slice(4) : part))
    .map((part) => part.replace(/[.\s]+$/, ''))
    .filter((part) => part.length > 0 && !part.includes(' '));
  return names.length > 0 ? names : undefined;
}

/**
 * Did the server reject our credentials? Covers the SSH wording and the FTP
 * reply codes, since the advice below is worth giving for either.
 */
const AUTH_FAILURE_PATTERNS = [
  'all configured authentication methods failed',
  'authentication failed',
  'permission denied',
  '530',
  'login incorrect'
];

export function isAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return AUTH_FAILURE_PATTERNS.some((p) => lower.includes(p));
}

export interface AuthContext {
  protocol: 'ftp' | 'ftps' | 'ftps-implicit' | 'sftp';
  username: string;
  auth: 'password' | 'privateKey';
}

/**
 * The two mistakes that produce almost every cPanel auth failure, in the order
 * they are worth checking. Neither is guessable from "authentication failed".
 *
 * The first is the expensive one: cPanel FTP sub-accounts are named
 * `user@domain` and cannot log in over SSH at all, so a profile switched from
 * FTP to SFTP keeps a username that can never work.
 */
export function authFailureAdvice(context: AuthContext): string[] {
  const notes: string[] = [];
  const atSign = context.username.indexOf('@');

  if (context.protocol === 'sftp') {
    if (atSign > 0) {
      notes.push(
        'The username looks like a cPanel FTP sub-account (' +
          context.username +
          '). SSH only accepts the main cPanel account, so try "' +
          context.username.slice(0, atSign) +
          '" instead, with the cPanel login password.'
      );
    }
    if (context.auth === 'password') {
      notes.push(
        'Many shared hosts disable password logins for SSH and accept keys only. Generate a key in cPanel > SSH Access, click Authorize on it, then switch Authentication to privateKey in Settings.'
      );
    }
    notes.push('Shell access sometimes has to be enabled for the account first — hosts usually do it on request.');
    return notes;
  }

  // FTP: the mirror-image mistake.
  if (atSign === -1) {
    notes.push(
      'cPanel FTP sub-accounts are named user@domain. If this is a sub-account rather than the main account, the domain part is required.'
    );
  }
  notes.push('Check the password by logging in to cPanel > FTP Accounts, where it can be reset without affecting anything else.');
  return notes;
}

const NOT_FOUND_PATTERNS = ['no such file', 'not found', '550'];

export function isPathNotFound(message: string): boolean {
  const lower = message.toLowerCase();
  return NOT_FOUND_PATTERNS.some((p) => lower.includes(p));
}

/**
 * The same account reaches the same files by different paths depending on the
 * protocol, and switching protocol silently invalidates the remote root:
 *
 * - a cPanel FTP sub-account is chrooted, so its world starts at `/public_html`;
 * - SSH logs in as the real user, so the same directory is
 *   `/home/<account>/public_html`.
 *
 * Returns the path the other protocol would use, or undefined when the current
 * one already looks right.
 */
export function suggestRemoteRoot(context: { protocol: string; username: string; remoteRoot: string }): string | undefined {
  const account = context.username.split('@')[0];
  if (!account) {
    return undefined;
  }
  const root = context.remoteRoot.startsWith('/') ? context.remoteRoot : '/' + context.remoteRoot;
  const homePrefix = '/home/' + account;

  if (context.protocol === 'sftp') {
    // Already absolute from the real filesystem root: nothing to suggest.
    if (root === homePrefix || root.startsWith(homePrefix + '/')) {
      return undefined;
    }
    return root === '/' ? homePrefix : homePrefix + root;
  }

  // FTP: a home-relative path usually has to lose the /home/<account> prefix.
  if (root.startsWith(homePrefix + '/')) {
    return root.slice(homePrefix.length);
  }
  return undefined;
}

/**
 * Re-point managed subtrees at a new remote root, so changing the root does not
 * leave every synced path dangling. Only paths that sat under the old root are
 * touched; anything else is the user's own and left alone.
 */
export function remapRoots(roots: string[], oldRoot: string, newRoot: string): string[] {
  const trim = (v: string): string => (v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v);
  const from = trim(oldRoot);
  const to = trim(newRoot);
  if (from === to) {
    return roots;
  }
  return roots.map((root) => {
    if (root === from) {
      return to;
    }
    if (from === '/') {
      return to + root;
    }
    return root.startsWith(from + '/') ? to + root.slice(from.length) : root;
  });
}
