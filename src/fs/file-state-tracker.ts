import { MtimeSource, RemoteFileEntry } from '../connection/types';

export interface FileOpenState {
  mtimeMs?: number;
  size: number;
  mtimeSource: MtimeSource;
  capturedAt: number;
}

/**
 * Remembers what the server said a file looked like when we last read or wrote
 * it. This is the baseline the save pipeline compares against to detect that
 * someone else changed the file on the server in the meantime.
 * Keys are URI strings so this module stays vscode-free.
 */
export class FileStateTracker {
  private readonly states = new Map<string, FileOpenState>();

  capture(uriKey: string, entry: RemoteFileEntry): void {
    this.states.set(uriKey, {
      mtimeMs: entry.mtimeMs,
      size: entry.size,
      mtimeSource: entry.mtimeSource,
      capturedAt: Date.now()
    });
  }

  get(uriKey: string): FileOpenState | undefined {
    return this.states.get(uriKey);
  }

  drop(uriKey: string): void {
    this.states.delete(uriKey);
  }

  move(oldKey: string, newKey: string): void {
    const state = this.states.get(oldKey);
    this.states.delete(oldKey);
    if (state) {
      this.states.set(newKey, state);
    }
  }
}
