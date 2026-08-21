import * as vscode from 'vscode';
import { renderUploadDialog, UploadDialogModel } from './upload-dialog-view';

/**
 * The confirmation shown before bytes leave for a production server.
 *
 * VS Code's own modal cannot be styled and truncates a long remote path to one
 * ellipsised line — precisely the line that answers "am I about to overwrite
 * the right file?". A webview can show the whole path, the size, how much
 * actually changed and the state of the backup, so that is what this uses.
 *
 * The trade-off is honest: a webview is an editor tab, not a window-blocking
 * modal. It takes focus, Enter confirms and Esc cancels, and closing the tab
 * counts as cancelling — never as consent.
 */

export type UploadAnswer = 'upload' | 'diff' | 'cancel';

export interface UploadDecision {
  answer: UploadAnswer;
  /** The "stop asking" checkbox; only ever offered for a plain confirmation. */
  suppress: boolean;
}

const VIEW_TYPE = 'remoteCodeCompanion.uploadConfirm';

const CANCELLED: UploadDecision = { answer: 'cancel', suppress: false };

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function titleFor(model: UploadDialogModel): string {
  if (model.targets.length === 1) {
    return 'Upload · ' + model.targets[0].fileName;
  }
  return 'Upload · ' + model.targets.length + ' files';
}

function asAnswer(value: unknown): UploadAnswer {
  return value === 'upload' || value === 'diff' ? value : 'cancel';
}

export class UploadDialog {
  /**
   * Two saves can finish their backups at the same time; two dialogs stacked on
   * top of each other would leave the user answering for a file they cannot see.
   * They queue instead.
   */
  private queue: Promise<unknown> = Promise.resolve();

  ask(model: UploadDialogModel): Promise<UploadDecision> {
    const run = (): Promise<UploadDecision> => this.show(model);
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private show(model: UploadDialogModel): Promise<UploadDecision> {
    return new Promise<UploadDecision>((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        titleFor(model),
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        { enableScripts: true, retainContextWhenHidden: true }
      );

      let settled = false;
      const settle = (decision: UploadDecision): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(decision);
        panel.dispose();
      };

      const subscription = panel.webview.onDidReceiveMessage((message: { answer?: unknown; suppress?: unknown }) => {
        settle({ answer: asAnswer(message?.answer), suppress: message?.suppress === true });
      });

      panel.onDidDispose(() => {
        subscription.dispose();
        // Closing the tab is a decision too, and the safe reading of it is "no".
        if (!settled) {
          settled = true;
          resolve(CANCELLED);
        }
      });

      panel.webview.html = renderUploadDialog(model, makeNonce());
    });
  }
}
