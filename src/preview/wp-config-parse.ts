/**
 * Read database credentials out of a WordPress `wp-config.php`.
 *
 * This is how the preview learns where production's data lives without asking the
 * user to retype anything. Parsing PHP with regex is normally a bad idea, but
 * these four defines are the most stable lines in the WordPress ecosystem, and the
 * alternative — executing an untrusted production file locally — is worse.
 */
export interface WpDatabaseConfig {
  name: string;
  user: string;
  password: string;
  /** As written; may include `:port` or be something other than localhost. */
  host: string;
  tablePrefix: string;
  charset?: string;
}

export interface WpConfigParseResult {
  config?: WpDatabaseConfig;
  /** Names that could not be found, for a message that says what is missing. */
  missing: string[];
}

/**
 * Match `define('DB_NAME', 'value')` in the forms WordPress and hosts actually
 * write it: either quote style, optional spaces, and the modern `define(...)` or
 * `defined(...) || define(...)` wrappers. Commented-out lines are skipped so a
 * host's leftover example values are not picked up.
 */
function findDefine(source: string, constant: string): string | undefined {
  const pattern = new RegExp(
    String.raw`^[^\S\r\n]*(?!//|#|\*)\s*define\s*\(\s*(['"])` +
      constant +
      String.raw`\1\s*,\s*(['"])([\s\S]*?)\2\s*\)`,
    'im'
  );
  const match = pattern.exec(stripBlockComments(source));
  return match ? match[3] : undefined;
}

/** Remove block comments, so a commented-out define is never matched. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function findTablePrefix(source: string): string | undefined {
  const match = /^[^\S\r\n]*\$table_prefix\s*=\s*(['"])([\s\S]*?)\1\s*;/im.exec(stripBlockComments(source));
  return match ? match[2] : undefined;
}

export function parseWpConfig(source: string): WpConfigParseResult {
  const name = findDefine(source, 'DB_NAME');
  const user = findDefine(source, 'DB_USER');
  const password = findDefine(source, 'DB_PASSWORD');
  const host = findDefine(source, 'DB_HOST');
  const tablePrefix = findTablePrefix(source);

  const missing: string[] = [];
  if (name === undefined) {
    missing.push('DB_NAME');
  }
  if (user === undefined) {
    missing.push('DB_USER');
  }
  if (password === undefined) {
    missing.push('DB_PASSWORD');
  }
  if (missing.length > 0) {
    return { missing };
  }

  return {
    missing: [],
    config: {
      name: name as string,
      user: user as string,
      password: password as string,
      host: host ?? 'localhost',
      // WordPress defaults to wp_ when the line is absent.
      tablePrefix: tablePrefix ?? 'wp_',
      charset: findDefine(source, 'DB_CHARSET')
    }
  };
}

/** Split `host:port` or `host:/socket/path` the way WordPress does. */
export function splitDbHost(host: string): { host: string; port?: number; socket?: string } {
  const trimmed = host.trim();
  const colon = trimmed.lastIndexOf(':');
  if (colon === -1) {
    return { host: trimmed };
  }
  const tail = trimmed.slice(colon + 1);
  if (/^\d+$/.test(tail)) {
    return { host: trimmed.slice(0, colon), port: Number(tail) };
  }
  return { host: trimmed.slice(0, colon), socket: tail };
}
