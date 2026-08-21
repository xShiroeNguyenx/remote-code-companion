import * as vscode from 'vscode';
import { config as settings } from '../config';
import { Logger } from '../core/logger';
import { isPhpFile, LintProblem, lintPhpFiles } from '../php/php-lint';
import { findPhp } from '../php/php-runtime';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { RemoteConfig } from '../profiles/types';
import { localPathFor } from './manifest';
import { PushResult } from './sync-engine';
import { FileStatus } from './types';

/**
 * The two things every path to a push needs, wherever it was started from:
 * refuse unparseable PHP, and report honestly what happened. Shared so the
 * push command and the right-click upload cannot drift apart on either.
 */

/** Newline inside a modal detail. */
const DIALOG_NEWLINE = `
`;

/**
 * Refuse to upload PHP that cannot be parsed. A syntax error does not degrade a
 * WordPress site, it blanks every page of it, so this is the one class of
 * mistake worth stopping a push over.
 *
 * Returns the files that may proceed. When PHP is missing the push continues:
 * a machine without PHP is a reason to skip the check, not to block work.
 */
export async function gateOnPhpSyntax(
  store: RemoteConfigStore,
  config: RemoteConfig,
  targets: FileStatus[],
  logger: Logger
): Promise<FileStatus[] | undefined> {
  if (!settings.lintPhpBeforePush()) {
    return targets;
  }
  const phpTargets = targets.filter((t) => isPhpFile(t.localRelPath));
  if (phpTargets.length === 0) {
    return targets;
  }
  const folder = store.folderFor(config.id);
  if (!folder) {
    return targets;
  }
  const runtime = await findPhp(settings.phpPath(), logger);
  if (!runtime) {
    logger.warn(`[php] no PHP found on this machine — syntax check skipped for ${phpTargets.length} file(s)`);
    return targets;
  }

  const problems: LintProblem[] = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking PHP syntax (${phpTargets.length} file(s))...` },
    () =>
      lintPhpFiles(
        runtime,
        phpTargets.map((t) => ({
          localPath: localPathFor(folder.uri.fsPath, t.localRelPath),
          label: t.localRelPath
        }))
      )
  );
  if (problems.length === 0) {
    return targets;
  }

  const broken = new Set(problems.map((p) => p.file));
  const rest = targets.filter((t) => !broken.has(t.localRelPath));
  const detail = problems
    .map((p) => `${p.file}${p.line ? ':' + p.line : ''} — ${p.message}`)
    .join(DIALOG_NEWLINE);

  const pushRest = `Push the other ${rest.length} file(s)`;
  const answer = await vscode.window.showErrorMessage(
    `${problems.length} file(s) have PHP syntax errors and were not uploaded.`,
    {
      modal: true,
      detail: [detail, 'A parse error makes every page of the site blank, so these are held back. Fix them and push again.'].join(
        DIALOG_NEWLINE + DIALOG_NEWLINE
      )
    },
    ...(rest.length > 0 ? [pushRest] : [])
  );
  for (const problem of problems) {
    logger.error(`[php] ${problem.file}${problem.line ? ':' + problem.line : ''} ${problem.message}`);
  }
  if (rest.length > 0 && answer === pushRest) {
    return rest;
  }
  return undefined;
}

/**
 * A push is never reported as a plain success: a cancelled file is still
 * pending, and a failed one needs the log. Saying "3 pushed" while two were
 * refused is how a deploy gets believed that never happened.
 */
export function reportPushResult(configName: string, result: PushResult, logger: Logger): void {
  const pushed = result.outcomes.filter((o) => o.outcome === 'pushed').length;
  const cancelled = result.outcomes.filter((o) => o.outcome === 'cancelled').length;
  const skipped = result.outcomes.filter((o) => o.outcome === 'skipped');
  const failed = result.outcomes.filter((o) => o.outcome === 'failed');

  for (const failure of failed) {
    logger.error(`push failed for ${failure.remotePath}: ${failure.detail ?? ''}`);
  }

  const parts = [`${pushed} pushed`];
  if (cancelled > 0) {
    parts.push(`${cancelled} cancelled (still pending)`);
  }
  if (skipped.length > 0) {
    parts.push(`${skipped.length} skipped (${skipped[0].detail ?? 'not pushable'})`);
  }
  if (failed.length > 0) {
    parts.push(`${failed.length} failed — see the output log`);
  }
  const message = `Push to "${configName}": ${parts.join(', ')}.`;
  if (failed.length > 0) {
    void vscode.window.showWarningMessage(message);
  } else {
    void vscode.window.showInformationMessage(message);
  }
}
