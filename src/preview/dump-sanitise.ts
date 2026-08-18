/**
 * Make a mysqldump file importable by an older client.
 *
 * MariaDB 10.11+ and MySQL 8.0.34+ prepend a "sandbox mode" directive to every
 * dump:
 *
 *     a conditional comment containing the client command backslash-minus,
 *     labelled "enable the sandbox mode".
 *
 * It is a client instruction, not data. A client older than the server — which is
 * the normal situation when production is a current MariaDB and the local machine
 * has whatever XAMPP shipped — does not recognise the `\-` command and stops at
 * line 1 with "Unknown command". Dropping the line loses nothing: it exists only to
 * restrict what the receiving client may execute.
 */

const SANDBOX_LINE = /^\s*\/\*M?!999999\\?-.*?\*\/\s*;?\s*$/;

export interface SanitiseResult {
  sql: string;
  /** Directives removed, for the log. */
  removed: string[];
}

export function sanitiseDump(sql: string): SanitiseResult {
  const removed: string[] = [];
  // Only the very start of the file is examined: a directive further down would be
  // inside data, and rewriting data is not this function's business.
  const lines = sql.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && index < 5) {
    if (SANDBOX_LINE.test(lines[index])) {
      removed.push(lines[index].trim());
      lines.splice(index, 1);
      continue;
    }
    index++;
  }
  return { sql: removed.length > 0 ? lines.join('\n') : sql, removed };
}

/**
 * Does this look like a dump at all? A shell pipeline reports the exit status of
 * its *last* command, so `mysqldump ... | gzip > file` returns success even when
 * mysqldump failed — leaving a file that is valid gzip and useless SQL. Checking
 * the content is the only reliable signal.
 */
export function looksLikeSqlDump(sql: string): { ok: boolean; reason?: string } {
  const head = sql.slice(0, 4096);
  if (sql.trim().length === 0) {
    return { ok: false, reason: 'the dump is empty — mysqldump produced no output' };
  }
  if (/\b(CREATE TABLE|INSERT INTO|DROP TABLE)\b/i.test(sql)) {
    return { ok: true };
  }
  if (/^(ERROR|mysqldump:)/im.test(head)) {
    const line = (/^(?:ERROR|mysqldump:).*/im.exec(head) ?? [''])[0];
    return { ok: false, reason: `mysqldump reported: ${line.trim().slice(0, 200)}` };
  }
  return {
    ok: false,
    reason: `the dump contains no table statements. It starts with: ${head.split(/\r?\n/).slice(0, 2).join(' / ').slice(0, 200)}`
  };
}
