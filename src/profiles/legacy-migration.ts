import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatError, Logger } from '../core/logger';
import { isValidProfileId } from '../core/rcc-uri';
import { LEGACY_PROFILE_STATE_KEY, LegacyProfileStoreShape, ServerProfile } from './types';

/**
 * Phase 1 stored server profiles in globalState, shared by every window. Phase 2
 * moves them into the folder they belong to. Migration keeps the original
 * profileId so SecretStorage entries and existing backups stay attached.
 */

export function readLegacyProfiles(context: vscode.ExtensionContext): ServerProfile[] {
  const shape = context.globalState.get<LegacyProfileStoreShape>(LEGACY_PROFILE_STATE_KEY);
  const profiles = Array.isArray(shape?.profiles) ? shape.profiles : [];
  return profiles.filter((p): p is ServerProfile => Boolean(p && typeof p.id === 'string' && isValidProfileId(p.id) && p.host));
}

export async function clearLegacyProfiles(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(LEGACY_PROFILE_STATE_KEY, undefined);
}

/** Drop one migrated profile; clears the key entirely once the list empties. */
export async function removeLegacyProfile(context: vscode.ExtensionContext, profileId: string): Promise<number> {
  const remaining = readLegacyProfiles(context).filter((p) => p.id !== profileId);
  if (remaining.length === 0) {
    await clearLegacyProfiles(context);
    return 0;
  }
  await context.globalState.update(LEGACY_PROFILE_STATE_KEY, { profiles: remaining } satisfies LegacyProfileStoreShape);
  return remaining.length;
}

/**
 * Copy `<globalStorage>/backups/<profileId>` into the folder's `.rcc/backups`.
 * Skips silently when there is nothing to copy, and never overwrites an
 * existing index — a second migration must not merge two histories blindly.
 */
export async function copyLegacyBackups(
  globalStorageDir: string,
  profileId: string,
  targetBackupDir: string,
  logger: Logger
): Promise<number> {
  const source = path.join(globalStorageDir, 'backups', profileId);
  try {
    await fs.promises.access(path.join(source, 'index.json'));
  } catch {
    return 0;
  }
  try {
    await fs.promises.access(path.join(targetBackupDir, 'index.json'));
    logger.info(`[migration] ${targetBackupDir} already has backups — leaving the old ones in place`);
    return 0;
  } catch {
    // target is empty: safe to copy
  }
  try {
    await fs.promises.mkdir(path.dirname(targetBackupDir), { recursive: true });
    await fs.promises.cp(source, targetBackupDir, { recursive: true });
    const raw = await fs.promises.readFile(path.join(targetBackupDir, 'index.json'), 'utf8');
    const parsed = JSON.parse(raw) as { entries?: unknown[] };
    const count = Array.isArray(parsed.entries) ? parsed.entries.length : 0;
    logger.info(`[migration] copied ${count} backup(s) for ${profileId} into ${targetBackupDir}`);
    return count;
  } catch (err) {
    logger.error(`[migration] copying backups for ${profileId} failed`, err);
    void vscode.window.showWarningMessage(
      `Remote set up, but copying old backups failed: ${formatError(err)}. The originals are untouched.`
    );
    return 0;
  }
}
