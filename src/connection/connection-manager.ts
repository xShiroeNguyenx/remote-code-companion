import { AsyncQueue } from '../core/async-queue';
import { isConnectionError, RccError } from '../core/errors';
import { formatError, Logger } from '../core/logger';
import { basenameRemote, dirnameRemote, normalizeRemotePath } from '../core/remote-path';
import { ServerProfile } from '../profiles/types';
import { FtpRemoteClient } from './ftp-remote-client';
import { SftpRemoteClient } from './sftp-remote-client';
import { ConnectionState, RemoteClient, RemoteCredentials, RemoteFileEntry } from './types';

const KEEPALIVE_INTERVAL_MS = 30000;
const RECONNECT_BACKOFF_MS = 1000;
const DEFAULT_LISTING_TTL_MS = 10000;

export interface ConnectionManagerDeps {
  getProfile(profileId: string): ServerProfile | undefined;
  getCredentials(profile: ServerProfile): Promise<RemoteCredentials>;
  logger: Logger;
  idleTimeoutMs(): number;
  listingTtlMs?: number;
  onStateChange?(profileId: string, state: ConnectionState): void;
  onBusyChange?(pendingTotal: number): void;
}

export function createRemoteClient(profile: ServerProfile, logger: Logger): RemoteClient {
  if (profile.protocol === 'sftp') {
    return new SftpRemoteClient(profile, logger);
  }
  return new FtpRemoteClient(profile, logger);
}

interface CachedListing {
  entries: RemoteFileEntry[];
  at: number;
}

type MdtmCapability = 'unknown' | 'yes' | 'no';

/**
 * One managed connection per profile: serialized op queue, keep-alive,
 * idle-close, single reconnect-and-replay, and a short-TTL listing cache
 * (on FTP a stat() is a LIST of the parent directory, and VS Code stats a lot).
 */
export class ManagedConnection {
  private client: RemoteClient;
  private readonly queue = new AsyncQueue();
  private state: ConnectionState = 'disconnected';
  private mdtm: MdtmCapability = 'unknown';
  private readonly listingCache = new Map<string, CachedListing>();
  private keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    public readonly profile: ServerProfile,
    private readonly deps: ConnectionManagerDeps
  ) {
    this.client = createRemoteClient(profile, deps.logger);
  }

  getState(): ConnectionState {
    return this.state;
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.deps.onStateChange?.(this.profile.id, state);
    }
  }

  private get ttl(): number {
    return this.deps.listingTtlMs ?? DEFAULT_LISTING_TTL_MS;
  }

  /** Run a raw client op through the queue with connect-on-demand and one reconnect+replay. */
  private run<T>(op: (client: RemoteClient) => Promise<T>, opts: { touchIdle?: boolean } = {}): Promise<T> {
    const touchIdle = opts.touchIdle ?? true;
    return this.queue.run(async () => {
      await this.ensureConnected();
      if (touchIdle) {
        this.resetIdleTimer();
      }
      try {
        return await op(this.client);
      } catch (err) {
        if (!isConnectionError(err)) {
          throw err;
        }
        this.deps.logger.warn(
          `[${this.profile.name}] connection error (${formatError(err)}) — reconnecting and retrying once`
        );
        await this.reconnect();
        return await op(this.client);
      }
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isConnected()) {
      return;
    }
    await this.doConnect();
  }

  private async doConnect(): Promise<void> {
    this.setState('connecting');
    try {
      const creds = await this.deps.getCredentials(this.profile);
      await this.client.connect(creds);
      this.setState('connected');
      this.startKeepAlive();
      this.resetIdleTimer();
      this.deps.logger.info(`[${this.profile.name}] connected (${this.profile.protocol}://${this.profile.host}:${this.profile.port})`);
    } catch (err) {
      this.setState('disconnected');
      this.stopTimers();
      if (err instanceof RccError) {
        throw err;
      }
      throw new RccError(
        'ConnectionFailed',
        `Could not connect to ${this.profile.name} (${this.profile.host}): ${formatError(err)}`
      );
    }
  }

  private async reconnect(): Promise<void> {
    try {
      await this.client.disconnect();
    } catch {
      // best effort
    }
    this.setState('disconnected');
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_BACKOFF_MS));
    await this.doConnect();
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.client.isConnected() && this.queue.idle) {
        this.run((c) => c.noop(), { touchIdle: false }).catch((err) => {
          this.deps.logger.debug(`[${this.profile.name}] keep-alive failed: ${formatError(err)}`);
        });
      }
    }, KEEPALIVE_INTERVAL_MS);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.deps.logger.info(`[${this.profile.name}] closing idle connection`);
      void this.disconnect();
    }, this.deps.idleTimeoutMs());
    this.idleTimer.unref?.();
  }

  private stopTimers(): void {
    this.stopKeepAlive();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  async connect(): Promise<void> {
    await this.withBusy(() => this.run(async () => undefined));
  }

  async disconnect(): Promise<void> {
    this.stopTimers();
    this.listingCache.clear();
    try {
      await this.client.disconnect();
    } finally {
      this.setState('disconnected');
    }
  }

  private async withBusy<T>(fn: () => Promise<T>): Promise<T> {
    this.deps.onBusyChange?.(+1);
    try {
      return await fn();
    } finally {
      this.deps.onBusyChange?.(-1);
    }
  }

  // ---- cached / derived operations -------------------------------------

  async list(dirPath: string): Promise<RemoteFileEntry[]> {
    const dir = normalizeRemotePath(dirPath);
    const cached = this.listingCache.get(dir);
    if (cached && Date.now() - cached.at < this.ttl) {
      return cached.entries;
    }
    return this.withBusy(async () => {
      const entries = await this.run((c) => c.list(dir));
      this.listingCache.set(dir, { entries, at: Date.now() });
      return entries;
    });
  }

  async stat(remotePath: string): Promise<RemoteFileEntry> {
    const p = normalizeRemotePath(remotePath);
    if (this.client.capabilities.nativeStat) {
      return this.withBusy(async () => {
        try {
          return await this.run((c) => c.stat!(p));
        } catch (err) {
          throw this.asNotFound(err, p);
        }
      });
    }
    // FTP: derive from the (cached) parent listing.
    if (p === '/') {
      return { name: '', path: '/', type: 'directory', size: 0, mtimeSource: 'none' };
    }
    const parent = dirnameRemote(p);
    const name = basenameRemote(p);
    const entries = await this.list(parent);
    const entry = entries.find((e) => e.name === name);
    if (!entry) {
      throw new RccError('FileNotFound', `Not found on server: ${p}`);
    }
    // Refine file mtimes via MDTM once per connection; keep the source
    // consistent so VS Code never sees MDTM and LIST times mixed.
    if (entry.type === 'file' && entry.mtimeSource !== 'mdtm' && this.mdtm !== 'no') {
      try {
        const ms = await this.withBusy(() => this.run((c) => c.lastMod!(p)));
        entry.mtimeMs = ms;
        entry.mtimeSource = 'mdtm';
        this.mdtm = 'yes';
      } catch (err) {
        if (isConnectionError(err)) {
          throw err;
        }
        if (this.mdtm === 'unknown') {
          this.mdtm = 'no';
          this.deps.logger.info(`[${this.profile.name}] server does not support MDTM — conflict detection degraded to listing dates`);
        }
      }
    }
    return entry;
  }

  private asNotFound(err: unknown, p: string): unknown {
    const message = err instanceof Error ? err.message.toLowerCase() : '';
    if (message.includes('no such file') || message.includes('not found') || (err as { code?: number }).code === 2) {
      return new RccError('FileNotFound', `Not found on server: ${p}`);
    }
    return err;
  }

  async readFile(remotePath: string): Promise<Buffer> {
    const p = normalizeRemotePath(remotePath);
    return this.withBusy(() => this.run((c) => c.readFile(p)));
  }

  async writeFile(remotePath: string, data: Buffer): Promise<void> {
    const p = normalizeRemotePath(remotePath);
    await this.withBusy(() => this.run((c) => c.writeFile(p, data)));
    this.invalidate(dirnameRemote(p));
  }

  async remove(remotePath: string, type: RemoteFileEntry['type']): Promise<void> {
    const p = normalizeRemotePath(remotePath);
    await this.withBusy(() => this.run((c) => c.remove(p, type)));
    this.invalidate(dirnameRemote(p));
    this.invalidateSubtree(p);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const from = normalizeRemotePath(oldPath);
    const to = normalizeRemotePath(newPath);
    await this.withBusy(() => this.run((c) => c.rename(from, to)));
    this.invalidate(dirnameRemote(from));
    this.invalidate(dirnameRemote(to));
    this.invalidateSubtree(from);
  }

  async mkdir(remotePath: string): Promise<void> {
    const p = normalizeRemotePath(remotePath);
    await this.withBusy(() => this.run((c) => c.mkdir(p)));
    this.invalidate(dirnameRemote(p));
  }

  invalidate(dirPath: string): void {
    this.listingCache.delete(normalizeRemotePath(dirPath));
  }

  invalidateSubtree(remotePath: string): void {
    const p = normalizeRemotePath(remotePath);
    for (const key of [...this.listingCache.keys()]) {
      if (key === p || key.startsWith(p + '/')) {
        this.listingCache.delete(key);
      }
    }
  }

  invalidateAll(): void {
    this.listingCache.clear();
  }
}

export class ConnectionManager {
  private readonly connections = new Map<string, ManagedConnection>();
  private busyTotal = 0;

  constructor(private readonly deps: ConnectionManagerDeps) {}

  getConnection(profileId: string): ManagedConnection {
    const existing = this.connections.get(profileId);
    if (existing) {
      return existing;
    }
    const profile = this.deps.getProfile(profileId);
    if (!profile) {
      throw new RccError('FileNotFound', `Unknown server profile: ${profileId}`);
    }
    const conn = new ManagedConnection(profile, {
      ...this.deps,
      onBusyChange: (delta) => {
        this.busyTotal = Math.max(0, this.busyTotal + delta);
        this.deps.onBusyChange?.(this.busyTotal);
      }
    });
    this.connections.set(profileId, conn);
    return conn;
  }

  state(profileId: string): ConnectionState {
    return this.connections.get(profileId)?.getState() ?? 'disconnected';
  }

  async connect(profileId: string): Promise<void> {
    await this.getConnection(profileId).connect();
  }

  async disconnect(profileId: string): Promise<void> {
    await this.connections.get(profileId)?.disconnect();
  }

  /** Drop the connection object entirely (after a profile edit or removal). */
  async drop(profileId: string): Promise<void> {
    const conn = this.connections.get(profileId);
    this.connections.delete(profileId);
    if (conn) {
      try {
        await conn.disconnect();
      } catch {
        // best effort
      }
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.drop(id)));
  }
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
  /** Names of entries directly under '/', when the root listing succeeded. */
  rootEntries?: string[];
}

/** Standalone connectivity check used by the profile wizard — no manager state involved. */
export async function testProfileConnection(
  profile: ServerProfile,
  creds: RemoteCredentials,
  logger: Logger
): Promise<ConnectionTestResult> {
  const client = createRemoteClient(profile, logger);
  try {
    await client.connect(creds);
    let rootEntries: string[] | undefined;
    try {
      const entries = await client.list('/');
      rootEntries = entries.map((e) => e.name);
    } catch {
      rootEntries = undefined;
    }
    // Verify the configured root actually exists.
    if (normalizeRemotePath(profile.remoteRoot) !== '/') {
      await client.list(profile.remoteRoot);
    }
    return { ok: true, rootEntries };
  } catch (err) {
    return { ok: false, error: formatError(err) };
  } finally {
    try {
      await client.disconnect();
    } catch {
      // ignore
    }
  }
}
