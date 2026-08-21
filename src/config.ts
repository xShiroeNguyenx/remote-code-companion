import * as vscode from 'vscode';
import { CONFIG_ROOT } from './constants';

const DEFAULT_TREE_EXCLUDES = ['**/wp-content/cache/**', '**/node_modules/**', '**/.git/**'];

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(CONFIG_ROOT);
}

export const config = {
  confirmOnSave: (): boolean => cfg().get<boolean>('confirmOnSave', true),
  /**
   * 'panel' is the styled dialog: it shows the whole remote path, the size and
   * how much changed. 'modal' is VS Code's own window-blocking box, for anyone
   * who would rather not have a tab open for a confirmation.
   */
  confirmStyle: (): 'panel' | 'modal' => cfg().get<'panel' | 'modal'>('confirm.style', 'panel'),
  conflictCheck: (): boolean => cfg().get<boolean>('conflictCheck', true),
  backupEnabled: (): boolean => cfg().get<boolean>('backup.enabled', true),
  backupRequired: (): boolean => cfg().get<boolean>('backup.required', true),
  backupMaxPerFile: (): number => cfg().get<number>('backup.maxPerFile', 10),
  backupMaxAgeDays: (): number => cfg().get<number>('backup.maxAgeDays', 30),
  idleTimeoutMs: (): number => cfg().get<number>('connection.idleTimeoutSeconds', 300) * 1000,
  maxFileSizeBytes: (): number => cfg().get<number>('maxFileSizeMB', 10) * 1024 * 1024,
  treeExcludes: (): string[] => cfg().get<string[]>('tree.excludes', DEFAULT_TREE_EXCLUDES),
  warnCriticalFiles: (): boolean => cfg().get<boolean>('wordpress.warnCriticalFiles', true),
  /**
   * When to spend a download hashing the server copy. 'auto' does it only when a
   * timestamp cannot settle the question and the answer matters.
   */
  verifyByHash: (): 'auto' | 'always' | 'never' =>
    cfg().get<'auto' | 'always' | 'never'>('sync.verifyByHash', 'auto'),
  warnOnFirstLocalSave: (): boolean => cfg().get<boolean>('sync.warnOnFirstLocalSave', true),
  /**
   * Pause between file transfers during a pull. Every FTP transfer opens a fresh
   * passive data connection, and shared hosts run connection-flood protection
   * that reads a rapid burst of them as an attack — the pause is what keeps a
   * large pull from getting the IP temporarily blocked.
   */
  pullDelayMs: (): number => Math.max(0, cfg().get<number>('sync.pullDelayMs', 100)),
  /** Empty means: find PHP on this machine automatically. */
  phpPath: (): string => cfg().get<string>('php.path', ''),
  /**
   * A PHP parse error blanks every page of a WordPress site, so it is worth
   * refusing to upload one. Off only makes sense if the local PHP disagrees
   * with the server version.
   */
  lintPhpBeforePush: (): boolean => cfg().get<boolean>('php.lintBeforePush', true),
  /** Folder containing mysqld; empty means look in the usual places. */
  mysqlBinDir: (): string => cfg().get<string>('mysql.binDir', '')
};
