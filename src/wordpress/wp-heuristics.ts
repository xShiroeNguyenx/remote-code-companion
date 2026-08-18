import { basenameRemote } from '../core/remote-path';

/** Typical document roots on shared hosting, in preference order. */
export const ROOT_GUESSES = ['public_html', 'www', 'htdocs', 'httpdocs', 'web'];

/** Files where a bad upload takes the whole site down — always confirm these. */
export const CRITICAL_FILES = ['wp-config.php', '.htaccess'];

export function isCriticalFile(remotePath: string): boolean {
  return CRITICAL_FILES.includes(basenameRemote(remotePath));
}

/** Given the names in '/', return known document-root candidates in preference order. */
export function suggestRootCandidates(rootEntryNames: string[]): string[] {
  const names = new Set(rootEntryNames);
  return ROOT_GUESSES.filter((g) => names.has(g));
}
