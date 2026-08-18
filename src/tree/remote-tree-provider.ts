import * as vscode from 'vscode';
import { config } from '../config';
import { ConnectionManager } from '../connection/connection-manager';
import { matchesAnyGlob } from '../core/glob';
import { formatError, Logger } from '../core/logger';
import { rccUri } from '../fs/uri';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { protocolLabel } from '../profiles/types';
import {
  CONTEXT_DIR,
  CONTEXT_FILE,
  CONTEXT_PROFILE_CONNECTED,
  CONTEXT_PROFILE_DISCONNECTED,
  RemoteNode
} from './types';

/**
 * Lazy tree: each remote-enabled workspace folder is a root, a directory is
 * listed only when expanded, nothing is ever prefetched — VS Code never crawls
 * the server.
 */
export class RemoteTreeProvider implements vscode.TreeDataProvider<RemoteNode> {
  private readonly emitter = new vscode.EventEmitter<RemoteNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private readonly store: RemoteConfigStore,
    private readonly manager: ConnectionManager,
    private readonly logger: Logger
  ) {}

  refresh(node?: RemoteNode): void {
    this.emitter.fire(node);
  }

  getTreeItem(node: RemoteNode): vscode.TreeItem {
    if (node.kind === 'profile') {
      const profile = this.store.get(node.profileId);
      const folder = this.store.folderFor(node.profileId);
      const state = this.manager.state(node.profileId);
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `p:${node.profileId}`;
      item.contextValue = state === 'connected' ? CONTEXT_PROFILE_CONNECTED : CONTEXT_PROFILE_DISCONNECTED;
      if (profile) {
        item.description =
          `${profile.protocol}://${profile.host}` + (profile.readOnly ? ' · read-only' : '');
        item.tooltip = [
          profile.name,
          folder ? `Folder: ${folder.name}` : undefined,
          protocolLabel(profile.protocol),
          `${profile.username}@${profile.host}:${profile.port}`,
          `Root: ${profile.remoteRoot}`,
          profile.readOnly ? 'Read-only — writes are blocked' : undefined,
          `State: ${state}`
        ]
          .filter(Boolean)
          .join('\n');
      }
      item.iconPath =
        state === 'connected'
          ? new vscode.ThemeIcon('vm-active', new vscode.ThemeColor('charts.green'))
          : state === 'connecting'
            ? new vscode.ThemeIcon('sync')
            : new vscode.ThemeIcon('vm');
      return item;
    }

    const uri = rccUri(node.profileId, node.path);
    if (node.kind === 'dir') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `${node.profileId}:${node.path}`;
      item.resourceUri = uri;
      item.contextValue = CONTEXT_DIR;
      if (node.fileType === 'symlink') {
        item.description = '→';
      }
      return item;
    }

    const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
    item.id = `${node.profileId}:${node.path}`;
    item.resourceUri = uri;
    item.contextValue = CONTEXT_FILE;
    item.command = {
      command: 'vscode.open',
      title: 'Open Remote File',
      arguments: [uri]
    };
    return item;
  }

  async getChildren(node?: RemoteNode): Promise<RemoteNode[]> {
    if (!node) {
      return this.store.all().map((p) => ({
        kind: 'profile' as const,
        profileId: p.id,
        path: p.remoteRoot,
        name: p.name
      }));
    }
    if (node.kind === 'file') {
      return [];
    }
    const profile = this.store.get(node.profileId);
    if (!profile) {
      return [];
    }
    try {
      const conn = this.manager.getConnection(node.profileId);
      const entries = await conn.list(node.path);
      const excludes = config.treeExcludes();
      return entries
        .filter((e) => !matchesAnyGlob(e.path, excludes))
        .sort((a, b) => {
          const aDir = a.type !== 'file' ? 0 : 1;
          const bDir = b.type !== 'file' ? 0 : 1;
          return aDir - bDir || a.name.localeCompare(b.name);
        })
        .map((e) => ({
          kind: e.type === 'file' ? ('file' as const) : ('dir' as const),
          profileId: node.profileId,
          path: e.path,
          name: e.name,
          fileType: e.type
        }));
    } catch (err) {
      this.logger.error(`listing ${node.path} on ${profile.name} failed`, err);
      void vscode.window.showErrorMessage(`${profile.name}: ${formatError(err)}`);
      return [];
    }
  }
}
