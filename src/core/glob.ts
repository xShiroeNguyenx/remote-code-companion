/**
 * Tiny glob matcher supporting `**`, `*` and `?` — enough for tree excludes
 * without pulling in a dependency. Patterns match against absolute remote paths.
 */
const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

export function globToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  const n = glob.length;
  while (i < n) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' at a segment boundary → match zero or more whole segments
        if ((i === 0 || glob[i - 1] === '/') && glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      out += '[^/]';
      i += 1;
    } else {
      out += c.replace(REGEX_SPECIALS, '\\$&');
      i += 1;
    }
  }
  return new RegExp('^' + out + '$');
}

export function matchesAnyGlob(remotePath: string, globs: string[]): boolean {
  const candidate = remotePath.startsWith('/') ? remotePath.slice(1) : remotePath;
  return globs.some((g) => {
    try {
      const re = globToRegExp(g.startsWith('/') ? g.slice(1) : g);
      return re.test(candidate) || re.test(remotePath);
    } catch {
      return false;
    }
  });
}
