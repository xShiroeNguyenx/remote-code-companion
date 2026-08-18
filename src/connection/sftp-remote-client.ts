import SftpClient from 'ssh2-sftp-client';
import { RccError } from '../core/errors';
import { Logger } from '../core/logger';
import { basenameRemote, joinRemote } from '../core/remote-path';
import { ServerProfile } from '../profiles/types';
import { RemoteClient, RemoteCredentials, RemoteFileEntry, RemoteFileType } from './types';

export class SftpRemoteClient implements RemoteClient {
  readonly capabilities = { nativeStat: true };
  private client: SftpClient | undefined;
  private connected = false;

  constructor(private readonly profile: ServerProfile, private readonly logger: Logger) {}

  async connect(creds: RemoteCredentials): Promise<void> {
    const client = new SftpClient();
    client.on('close', () => {
      this.connected = false;
    });
    client.on('end', () => {
      this.connected = false;
    });
    try {
      await client.connect({
        host: this.profile.host,
        port: this.profile.port,
        username: this.profile.username,
        password: creds.password,
        privateKey: creds.privateKey,
        passphrase: creds.passphrase,
        readyTimeout: 20000,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
        retries: 1
      });
    } catch (err) {
      try {
        await client.end();
      } catch {
        // ignore
      }
      throw err;
    }
    this.client = client;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connected = false;
    if (client) {
      try {
        await client.end();
      } catch (err) {
        this.logger.debug(`sftp end() failed: ${String(err)}`);
      }
    }
  }

  isConnected(): boolean {
    return this.connected && this.client !== undefined;
  }

  private sftp(): SftpClient {
    if (!this.client || !this.connected) {
      throw new RccError('ConnectionFailed', 'Not connected');
    }
    return this.client;
  }

  async list(dirPath: string): Promise<RemoteFileEntry[]> {
    const entries = await this.sftp().list(dirPath);
    return entries.map((e) => ({
      name: e.name,
      path: joinRemote(dirPath, e.name),
      type: (e.type === 'd' ? 'directory' : e.type === 'l' ? 'symlink' : 'file') as RemoteFileType,
      size: e.size,
      mtimeMs: e.modifyTime,
      mtimeSource: 'sftp' as const
    }));
  }

  async stat(remotePath: string): Promise<RemoteFileEntry> {
    const s = await this.sftp().stat(remotePath);
    const type: RemoteFileType = s.isDirectory ? 'directory' : s.isSymbolicLink ? 'symlink' : 'file';
    return {
      name: basenameRemote(remotePath),
      path: remotePath,
      type,
      size: s.size,
      mtimeMs: s.modifyTime,
      mtimeSource: 'sftp'
    };
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const result = await this.sftp().get(remotePath);
    if (Buffer.isBuffer(result)) {
      return result;
    }
    return Buffer.from(result as string);
  }

  async writeFile(remotePath: string, data: Buffer): Promise<void> {
    await this.sftp().put(data, remotePath);
  }

  async remove(remotePath: string, type: RemoteFileType): Promise<void> {
    if (type === 'directory') {
      await this.sftp().rmdir(remotePath, true);
    } else {
      await this.sftp().delete(remotePath);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.sftp().rename(oldPath, newPath);
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.sftp().mkdir(remotePath, true);
  }

  async noop(): Promise<void> {
    // ssh2 already sends protocol-level keepalives; this is a cheap end-to-end check.
    await this.sftp().cwd();
  }
}
