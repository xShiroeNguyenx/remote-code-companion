import * as path from 'path';

/**
 * All remote path math is POSIX-only. A Windows client must never leak `\`
 * separators or drive letters into server paths. Backslashes in user input are
 * treated as separators (nobody has a literal `\` in a WordPress path).
 */
export function normalizeRemotePath(input: string): string {
  let p = (input || '/').replace(/\\/g, '/').trim();
  if (!p.startsWith('/')) {
    p = '/' + p;
  }
  p = path.posix.normalize(p);
  if (p.length > 1 && p.endsWith('/')) {
    p = p.slice(0, -1);
  }
  return p === '.' ? '/' : p;
}

export function joinRemote(base: string, ...parts: string[]): string {
  return normalizeRemotePath(path.posix.join(normalizeRemotePath(base), ...parts));
}

export function dirnameRemote(p: string): string {
  return normalizeRemotePath(path.posix.dirname(normalizeRemotePath(p)));
}

export function basenameRemote(p: string): string {
  return path.posix.basename(normalizeRemotePath(p));
}

export function isWithinRemote(root: string, p: string): boolean {
  const normRoot = normalizeRemotePath(root);
  const normP = normalizeRemotePath(p);
  if (normRoot === '/') {
    return true;
  }
  return normP === normRoot || normP.startsWith(normRoot + '/');
}
