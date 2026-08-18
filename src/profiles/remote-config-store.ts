import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatError, Logger } from '../core/logger';
import { CONFIG_FILE, RCC_DIR, RCC_GITIGNORE, parseConfig, serializeConfig } from './config-file';
import { RemoteConfig } from './types';

export function rccDirOf(folder: vscode.WorkspaceFolder): string {
  return path.join(folder.uri.fsPath, RCC_DIR);
}

export function configPathOf(folder: vscode.WorkspaceFolder): string {
  return path.join(rccDirOf(folder), CONFIG_FILE);
}

export interface FolderRemote {
  folder: vscode.WorkspaceFolder;
  config: RemoteConfig;
}

export interface ConfigIssue {
  folder: vscode.WorkspaceFolder;
  error: string;
  /** Set when the folder was rejected because another folder already claims its id. */
  duplicateOfFolder?: string;
  /** The parsed config, available for a duplicate-id issue so it can be repaired. */
  config?: RemoteConfig;
}

/**
 * A remote belongs to a workspace folder, declared by `<folder>/.rcc/config.json`.
 * There is no global list: a folder without that file is simply not remote-enabled.
 *
 * `all()`/`get()` keep the shape the connection layer, tree and FS provider
 * already expect, so the change of storage stays contained here.
 */
export class RemoteConfigStore {
  private readonly byId = new Map<string, FolderRemote>();
  private issueList: ConfigIssue[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly logger: Logger) {}

  /** Re-scan every workspace folder. Cheap: one file read per folder. */
  async reload(): Promise<void> {
    this.byId.clear();
    this.issueList = [];
    const claimedBy = new Map<string, vscode.WorkspaceFolder>();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const file = configPathOf(folder);
      let raw: string;
      try {
        raw = await fs.promises.readFile(file, 'utf8');
      } catch {
        continue; // no remote declared in this folder — the common case
      }

      const result = parseConfig(raw);
      if (!result.ok) {
        this.issueList.push({ folder, error: result.error });
        this.logger.error(`[${folder.name}] .rcc/config.json is invalid: ${result.error}`);
        continue;
      }

      // Two folders sharing an id would collide in SecretStorage and in rcc:// URIs.
      const owner = claimedBy.get(result.config.id);
      if (owner) {
        this.issueList.push({
          folder,
          config: result.config,
          duplicateOfFolder: owner.name,
          error: `id "${result.config.id}" is already used by the folder "${owner.name}" — most likely this project was copied.`
        });
        this.logger.warn(`[${folder.name}] duplicate remote id ${result.config.id} (also in ${owner.name})`);
        continue;
      }

      claimedBy.set(result.config.id, folder);
      this.byId.set(result.config.id, { folder, config: result.config });
      this.logger.info(
        `[${folder.name}] remote ${result.config.protocol}://${result.config.host} (root ${result.config.remoteRoot})`
      );
    }

    this.emitter.fire();
  }

  all(): RemoteConfig[] {
    return [...this.byId.values()].map((r) => r.config);
  }

  remotes(): FolderRemote[] {
    return [...this.byId.values()];
  }

  get(id: string): RemoteConfig | undefined {
    return this.byId.get(id)?.config;
  }

  folderFor(id: string): vscode.WorkspaceFolder | undefined {
    return this.byId.get(id)?.folder;
  }

  configIn(folder: vscode.WorkspaceFolder): RemoteConfig | undefined {
    return this.remotes().find((r) => r.folder.uri.toString() === folder.uri.toString())?.config;
  }

  hasAny(): boolean {
    return this.byId.size > 0;
  }

  issues(): ConfigIssue[] {
    return [...this.issueList];
  }

  /** Backups live beside the source they protect. */
  backupDirFor(id: string): string | undefined {
    const folder = this.folderFor(id);
    return folder ? path.join(rccDirOf(folder), 'backups') : undefined;
  }

  async write(folder: vscode.WorkspaceFolder, config: RemoteConfig): Promise<void> {
    const dir = rccDirOf(folder);
    await fs.promises.mkdir(dir, { recursive: true });

    // Seed the ignore file once; never clobber a user's edits to it.
    const ignore = path.join(dir, '.gitignore');
    try {
      await fs.promises.access(ignore);
    } catch {
      await fs.promises.writeFile(ignore, RCC_GITIGNORE, 'utf8');
    }

    const target = configPathOf(folder);
    const tmp = target + '.tmp';
    await fs.promises.writeFile(tmp, serializeConfig({ ...config, updatedAt: Date.now() }), 'utf8');
    await fs.promises.rename(tmp, target);
    this.logger.info(`[${folder.name}] wrote ${path.relative(folder.uri.fsPath, target)}`);
    await this.reload();
  }

  /** Removes the declaration only — pulled source and backups stay on disk. */
  async deleteConfig(folder: vscode.WorkspaceFolder): Promise<void> {
    try {
      await fs.promises.unlink(configPathOf(folder));
    } catch (err) {
      this.logger.debug(`removing config failed: ${formatError(err)}`);
    }
    await this.reload();
  }
}
