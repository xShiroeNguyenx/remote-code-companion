import * as vscode from 'vscode';
import { OUTPUT_CHANNEL_NAME } from './constants';
import { formatError, Logger } from './core/logger';

class OutputChannelLogger implements Logger {
  private channel: vscode.OutputChannel | undefined;

  private out(): vscode.OutputChannel {
    if (!this.channel) {
      this.channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    }
    return this.channel;
  }

  private line(level: string, message: string): void {
    const ts = new Date().toISOString().slice(11, 19);
    this.out().appendLine(`[${ts}] [${level}] ${message}`);
  }

  debug(message: string): void {
    this.line('debug', message);
  }

  info(message: string): void {
    this.line('info', message);
  }

  warn(message: string): void {
    this.line('warn', message);
  }

  error(message: string, err?: unknown): void {
    this.line('error', err === undefined ? message : `${message}: ${formatError(err)}`);
  }

  show(): void {
    this.out().show(true);
  }

  dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }
}

export const log = new OutputChannelLogger();
