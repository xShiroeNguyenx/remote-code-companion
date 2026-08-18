import * as vscode from 'vscode';
import { config } from '../config';
import { ConnectionManager } from '../connection/connection-manager';
import { Logger } from '../core/logger';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { parseRccParts } from './uri';

/**
 * Readonly provider on the rcc-remote: scheme. Every request downloads fresh
 * bytes from the server (the URI carries a nonce query so diffs always re-fetch)
 * — this is the "Server" side of every diff.
 */
export class RemoteContentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly profiles: RemoteConfigStore,
    private readonly manager: ConnectionManager,
    private readonly logger: Logger
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { profileId, remotePath } = parseRccParts(uri);
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`No server profile for ${uri.toString()}`);
    }
    const conn = this.manager.getConnection(profileId);
    const entry = await conn.stat(remotePath);
    if (entry.size > config.maxFileSizeBytes()) {
      return `(file too large to preview: ${entry.size} bytes)`;
    }
    const bytes = await conn.readFile(remotePath);
    return bytes.toString('utf8');
  }
}
