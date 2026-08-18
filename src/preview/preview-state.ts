import * as fs from 'fs';
import * as path from 'path';

/**
 * What the preview remembers between sessions: whether production's database has
 * been cloned, and into which local database.
 *
 * Stored outside the WordPress document root on purpose — inside it, the built-in
 * server would happily serve this file to anything that asked for it.
 */
export interface PreviewState {
  database?: {
    name: string;
    tablePrefix: string;
  };
  clonedAt?: number;
  /** For the summary: which remote database the copy came from. */
  sourceDatabase?: string;
}

function stateFile(storageDir: string, profileId: string): string {
  return path.join(storageDir, 'preview', `state-${profileId}.json`);
}

export function readState(storageDir: string, profileId: string): PreviewState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(storageDir, profileId), 'utf8')) as PreviewState;
    // A state without a usable database entry is the same as no state at all.
    if (!parsed.database?.name || !parsed.database?.tablePrefix) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

export function writeState(storageDir: string, profileId: string, state: PreviewState): void {
  const target = stateFile(storageDir, profileId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

export function clearState(storageDir: string, profileId: string): void {
  fs.rmSync(stateFile(storageDir, profileId), { force: true });
}

/** Local database name for a profile; scoped by id so profiles never share data. */
export function localDatabaseName(profileId: string): string {
  return `rcc_preview_${profileId}`;
}
