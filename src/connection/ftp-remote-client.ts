import { Client as FtpClient, FileInfo } from 'basic-ftp';
import { Readable, Writable } from 'stream';
import { RccError } from '../core/errors';
import { parseRawListDate } from '../core/ftp-date';
import { Logger } from '../core/logger';
import { joinRemote } from '../core/remote-path';
import { ServerProfile } from '../profiles/types';
import { RemoteClient, RemoteCredentials, RemoteFileEntry, RemoteFileType } from './types';

const CONNECT_TIMEOUT_MS = 30000;

export class FtpRemoteClient implements RemoteClient {
  readonly capabilities = { nativeStat: false };
  private client: FtpClient | undefined;

  constructor(private readonly profile: ServerProfile, private readonly logger: Logger) {}

  async connect(creds: RemoteCredentials): Promise<void> {
    // basic-ftp clients cannot be reused after close — always start fresh.
    this.client = new FtpClient(CONNECT_TIMEOUT_MS);
    const secure =
      this.profile.protocol === 'ftps' ? true : this.profile.protocol === 'ftps-implicit' ? ('implicit' as const) : false;
    try {
      await this.client.access({
        host: this.profile.host,
        port: this.profile.port,
        user: this.profile.username,
        password: creds.password,
        secure,
        secureOptions: {
          rejectUnauthorized: this.profile.ftpSecureRejectUnauthorized ?? true
        }
      });
    } catch (err) {
      this.client.close();
      this.client = undefined;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.client?.close();
    this.client = undefined;
  }

  isConnected(): boolean {
    return this.client !== undefined && !this.client.closed;
  }

  private ftp(): FtpClient {
    if (!this.client || this.client.closed) {
      throw new RccError('ConnectionFailed', 'Client is closed');
    }
    return this.client;
  }

  async list(dirPath: string): Promise<RemoteFileEntry[]> {
    const infos = await this.ftp().list(dirPath);
    return infos
      .filter((info) => info.name !== '.' && info.name !== '..')
      .map((info) => this.toEntry(dirPath, info));
  }

  private toEntry(dirPath: string, info: FileInfo): RemoteFileEntry {
    const type: RemoteFileType = info.isDirectory ? 'directory' : info.isSymbolicLink ? 'symlink' : 'file';
    let mtimeMs: number | undefined;
    let mtimeSource: RemoteFileEntry['mtimeSource'] = 'none';
    if (info.modifiedAt) {
      // Only present for MLSD listings — precise UTC.
      mtimeMs = info.modifiedAt.getTime();
      mtimeSource = 'mdtm';
    } else {
      const parsed = parseRawListDate(info.rawModifiedAt);
      if (parsed !== undefined) {
        mtimeMs = parsed;
        mtimeSource = 'listing';
      }
    }
    return { name: info.name, path: joinRemote(dirPath, info.name), type, size: info.size, mtimeMs, mtimeSource };
  }

  async lastMod(remotePath: string): Promise<number> {
    const date = await this.ftp().lastMod(remotePath);
    return date.getTime();
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      }
    });
    await this.ftp().downloadTo(sink, remotePath);
    return Buffer.concat(chunks);
  }

  async writeFile(remotePath: string, data: Buffer): Promise<void> {
    await this.ftp().uploadFrom(Readable.from(data), remotePath);
  }

  async remove(remotePath: string, type: RemoteFileType): Promise<void> {
    if (type === 'directory') {
      await this.ftp().removeDir(remotePath);
    } else {
      await this.ftp().remove(remotePath);
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.ftp().rename(oldPath, newPath);
  }

  async mkdir(remotePath: string): Promise<void> {
    await this.ftp().ensureDir(remotePath);
  }

  async noop(): Promise<void> {
    await this.ftp().send('NOOP');
  }
}
