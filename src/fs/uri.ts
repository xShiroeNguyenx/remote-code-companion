import * as vscode from 'vscode';
import { DIFF_SCHEME, SCHEME } from '../constants';
import { makeRccParts, parseRccParts as parseParts } from '../core/rcc-uri';
export { basenameRemote, dirnameRemote, joinRemote, normalizeRemotePath } from '../core/remote-path';

/** Build an rcc:// URI for a file/dir on a server profile. */
export function rccUri(profileId: string, remotePath: string): vscode.Uri {
  return vscode.Uri.from(makeRccParts(profileId, remotePath));
}

/** Build an rcc-remote:// snapshot URI (fresh server content, readonly, for diffs). */
export function remoteSnapshotUri(profileId: string, remotePath: string): vscode.Uri {
  const parts = makeRccParts(profileId, remotePath, DIFF_SCHEME);
  // The nonce forces VS Code to re-request content on every diff.
  return vscode.Uri.from({ ...parts, query: `t=${Date.now()}` });
}

export function parseRccParts(uri: vscode.Uri): { profileId: string; remotePath: string } {
  if (uri.scheme !== SCHEME && uri.scheme !== DIFF_SCHEME) {
    throw new Error(`Not a remote URI: ${uri.toString()}`);
  }
  return parseParts(uri);
}
