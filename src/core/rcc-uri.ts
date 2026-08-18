import * as crypto from 'crypto';
import { SCHEME } from '../constants';
import { normalizeRemotePath } from './remote-path';

/**
 * URI layout: rcc://<profileId>/<absolute-remote-path>
 * The profile id lives in the authority, which vscode.Uri lowercases —
 * so profile ids MUST be lowercase hex.
 */
export interface RccUriParts {
  scheme: string;
  authority: string;
  path: string;
}

const PROFILE_ID_RE = /^[0-9a-f]{8}$/;

export function isValidProfileId(id: string): boolean {
  return PROFILE_ID_RE.test(id);
}

export function newProfileId(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function makeRccParts(profileId: string, remotePath: string, scheme: string = SCHEME): RccUriParts {
  const id = profileId.toLowerCase();
  if (!isValidProfileId(id)) {
    throw new Error(`Invalid profile id in URI: ${profileId}`);
  }
  return { scheme, authority: id, path: normalizeRemotePath(remotePath) };
}

/** Accepts anything URI-shaped (vscode.Uri satisfies this structurally). */
export function parseRccParts(uri: { authority: string; path: string }): { profileId: string; remotePath: string } {
  const profileId = (uri.authority || '').toLowerCase();
  if (!isValidProfileId(profileId)) {
    throw new Error(`Invalid remote URI authority: "${uri.authority}"`);
  }
  return { profileId, remotePath: normalizeRemotePath(uri.path || '/') };
}
