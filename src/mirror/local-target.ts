import * as path from 'path';
import * as vscode from 'vscode';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { RemoteConfig } from '../profiles/types';

export interface LocalTarget {
  config: RemoteConfig;
  folder: vscode.WorkspaceFolder;
  /** POSIX, relative to the folder. Empty string when the URI *is* the folder. */
  localRelPath: string;
}

/**
 * Resolve a local path to the remote-enabled folder that owns it, if any.
 * Shared by the save hook and the upload commands so both answer "does this
 * file belong to a remote?" the same way.
 */
export function localTarget(store: RemoteConfigStore, uri: vscode.Uri): LocalTarget | undefined {
  if (uri.scheme !== 'file') {
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }
  const config = store.configIn(folder);
  if (!config) {
    return undefined;
  }
  const rel = path.relative(folder.uri.fsPath, uri.fsPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined; // outside the folder despite the workspace match
  }
  return { config, folder, localRelPath: rel.split(path.sep).join('/') };
}
