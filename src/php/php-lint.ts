import { baseArgs, PhpRuntime, runPhp } from './php-runtime';

/**
 * `php -l` on the files a push is about to upload. A PHP parse error is the one
 * mistake that takes a whole WordPress site down — every page becomes a blank
 * screen — and it costs milliseconds to catch locally, so it is worth blocking a
 * push over.
 *
 * This is not a linter for style or correctness: it only answers "will PHP be
 * able to parse this file at all?", which is exactly the question with a
 * catastrophic answer.
 */
export interface LintProblem {
  /** The path as given to us, so callers can map it back to their own list. */
  file: string;
  line?: number;
  message: string;
}

/**
 * `php -l` prints, e.g.:
 *   Parse error: syntax error, unexpected token "{", expecting variable in C:\x.php on line 2
 * Kept pure so the parsing is unit-tested rather than discovered in production.
 */
export function parseLintOutput(output: string, file: string): LintProblem | undefined {
  const text = output.replace(/\r/g, '').trim();
  if (!text || /^No syntax errors detected/m.test(text)) {
    return undefined;
  }
  const detailed = /(?:Parse|Fatal) error:\s*(.+?)\s+in\s+.+?\s+on line\s+(\d+)/is.exec(text);
  if (detailed) {
    return { file, line: Number(detailed[2]), message: detailed[1].trim() };
  }
  const loose = /(?:Parse|Fatal) error:\s*(.+)/i.exec(text);
  if (loose) {
    return { file, message: loose[1].split('\n')[0].trim() };
  }
  // Something went wrong that we cannot attribute to a line: report it verbatim
  // rather than treating the file as clean.
  return /Errors parsing/i.test(text) ? { file, message: text.split('\n')[0] } : undefined;
}

export function isPhpFile(filePath: string): boolean {
  return /\.(php|phtml|inc)$/i.test(filePath);
}

export interface LintTarget {
  /** Absolute local path handed to PHP. */
  localPath: string;
  /** Label shown to the user, usually the remote-relative path. */
  label: string;
}

export async function lintPhpFiles(runtime: PhpRuntime, targets: LintTarget[]): Promise<LintProblem[]> {
  const problems: LintProblem[] = [];
  for (const target of targets) {
    // No extensions needed to parse, and -n keeps a broken php.ini from turning
    // into fake errors.
    const result = await runPhp(runtime, [...baseArgs(runtime), '-l', target.localPath]);
    const problem = parseLintOutput(result.stdout + '\n' + result.stderr, target.label);
    if (problem) {
      problems.push(problem);
    } else if (result.code !== 0 && result.code !== -1) {
      problems.push({ file: target.label, message: `php -l exited with code ${result.code}` });
    }
  }
  return problems;
}
