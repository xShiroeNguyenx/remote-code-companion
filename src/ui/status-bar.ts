import * as vscode from 'vscode';
import { ConnectionState } from '../connection/types';

/**
 * Which copy the active editor is showing. Getting this wrong is the easiest way
 * to lose work in this extension — a local save waits for a push, an `rcc://`
 * save is already live — so the distinction is always on screen.
 */
export interface SyncContext {
  kind: 'local' | 'live' | 'none';
  host?: string;
  pending?: number;
}

export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private busy = 0;
  private readonly connected = new Set<string>();
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private context: SyncContext = { kind: 'none' };

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.update();
  }

  onConnectionState(profileId: string, state: ConnectionState): void {
    if (state === 'connected') {
      this.connected.add(profileId);
    } else if (state === 'disconnected') {
      this.connected.delete(profileId);
    }
    this.update();
  }

  onBusyChange(pendingTotal: number): void {
    this.busy = pendingTotal;
    this.update();
  }

  setSyncContext(context: SyncContext): void {
    this.context = context;
    this.update();
  }

  flashUploaded(fileName: string): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    this.item.text = `$(check) Uploaded ${fileName}`;
    this.item.command = 'remoteCodeCompanion.showOutput';
    this.item.show();
    this.flashTimer = setTimeout(() => {
      this.flashTimer = undefined;
      this.update();
    }, 4000);
  }

  private update(): void {
    if (this.flashTimer) {
      return; // let the flash finish
    }
    if (this.busy > 0) {
      this.item.text = '$(sync~spin) Remote';
      this.item.tooltip = 'Remote Code Companion: transferring...';
      this.item.command = 'remoteCodeCompanion.showOutput';
      this.item.show();
      return;
    }

    if (this.context.kind === 'local') {
      const pending = this.context.pending ?? 0;
      this.item.text = pending > 0 ? `$(cloud-upload) RCC: local · ${pending} pending` : '$(check) RCC: local · in sync';
      this.item.tooltip =
        pending > 0
          ? `${pending} file(s) edited locally and not pushed yet.\nSaving keeps changes on disk — click to push.`
          : 'This file is a local copy. Saving keeps changes on disk until you push.';
      this.item.command = 'remoteCodeCompanion.push';
      this.item.show();
      return;
    }

    if (this.context.kind === 'live') {
      this.item.text = `$(broadcast) RCC: live · ${this.context.host ?? 'server'}`;
      this.item.tooltip = `You are editing the server copy directly — Ctrl+S uploads immediately (behind backup and confirmation).`;
      this.item.command = 'remoteCodeCompanion.showOutput';
      this.item.show();
      return;
    }

    if (this.connected.size > 0) {
      this.item.text = `$(remote) ${this.connected.size}`;
      this.item.tooltip = `Remote Code Companion: ${this.connected.size} server(s) connected`;
      this.item.command = 'remoteCodeCompanion.showOutput';
      this.item.show();
      return;
    }
    this.item.hide();
  }

  dispose(): void {
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
    }
    this.item.dispose();
  }
}
