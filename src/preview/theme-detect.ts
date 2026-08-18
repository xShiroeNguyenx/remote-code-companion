/**
 * Which theme (or plugin) is this folder actually working on? Derived from the
 * synced subtrees rather than asked for, because the answer is already recorded
 * there — a pull of `/public_html/wp-content/themes/zosia` says everything.
 */
export interface PreviewTarget {
  kind: 'theme' | 'plugin';
  /** Directory name, which is also the WordPress slug. */
  name: string;
  /** Remote path of the subtree, so the local directory can be resolved. */
  remotePath: string;
}

const SEGMENTS: { marker: string; kind: PreviewTarget['kind'] }[] = [
  { marker: 'themes', kind: 'theme' },
  { marker: 'plugins', kind: 'plugin' }
];

/**
 * Find previewable targets in a list of synced remote paths. A path deeper than
 * the theme directory still resolves to the theme itself, since that is what
 * WordPress has to activate.
 */
export function findPreviewTargets(roots: string[]): PreviewTarget[] {
  const found = new Map<string, PreviewTarget>();
  for (const root of roots) {
    const parts = root.split('/').filter(Boolean);
    const contentAt = parts.lastIndexOf('wp-content');
    if (contentAt === -1) {
      continue;
    }
    const marker = parts[contentAt + 1];
    const name = parts[contentAt + 2];
    if (!marker || !name) {
      continue;
    }
    const match = SEGMENTS.find((s) => s.marker === marker);
    if (!match) {
      continue;
    }
    const remotePath = '/' + parts.slice(0, contentAt + 3).join('/');
    found.set(remotePath, { kind: match.kind, name, remotePath });
  }
  return [...found.values()];
}
