import { ChildProcess, spawn } from 'child_process';
import * as net from 'net';
import { Logger } from '../core/logger';
import { baseArgs, PhpRuntime, usableExtensions, WORDPRESS_EXTENSIONS } from '../php/php-runtime';
import { SitePaths } from './wordpress-site';

/**
 * PHP's built-in web server, one per previewed remote. It is the whole web stack
 * here: no Apache, no configuration files, nothing installed.
 */
export interface RunningPreview {
  profileId: string;
  port: number;
  url: string;
  process: ChildProcess;
}

/** First free port at or above `from`, so two previews never collide. */
export function findFreePort(from: number, attempts = 40): Promise<number> {
  const tryPort = (port: number, left: number): Promise<number> =>
    new Promise((resolve, reject) => {
      if (left <= 0) {
        reject(new Error('no free port found for the preview'));
        return;
      }
      const probe = net.createServer();
      probe.once('error', () => {
        probe.close();
        tryPort(port + 1, left - 1).then(resolve, reject);
      });
      probe.once('listening', () => {
        probe.close(() => resolve(port));
      });
      probe.listen(port, '127.0.0.1');
    });
  return tryPort(from, attempts);
}

export class PreviewServers {
  private readonly running = new Map<string, RunningPreview>();

  constructor(private readonly logger: Logger) {}

  get(profileId: string): RunningPreview | undefined {
    return this.running.get(profileId);
  }

  any(): RunningPreview[] {
    return [...this.running.values()];
  }

  async start(profileId: string, runtime: PhpRuntime, paths: SitePaths, port: number): Promise<RunningPreview> {
    await this.stop(profileId);
    const args = [
      ...baseArgs(runtime, usableExtensions(runtime, WORDPRESS_EXTENSIONS)),
      '-S',
      `127.0.0.1:${port}`,
      '-t',
      paths.root,
      paths.routerFile
    ];
    const child = spawn(runtime.exe, args, { cwd: paths.root, windowsHide: true });
    const preview: RunningPreview = {
      profileId,
      port,
      url: `http://127.0.0.1:${port}`,
      process: child
    };

    // The built-in server logs requests and PHP notices to stderr; that is the
    // most useful output there is when a theme errors, so it goes to the log.
    child.stderr?.on('data', (data) => {
      for (const line of String(data).split(/\r?\n/)) {
        if (line.trim()) {
          this.logger.info(`[preview] ${line.trim()}`);
        }
      }
    });
    child.stdout?.on('data', (data) => this.logger.debug(`[preview] ${String(data).trim()}`));
    child.on('exit', (code) => {
      this.logger.info(`[preview] server for ${profileId} exited (code ${code ?? 'null'})`);
      if (this.running.get(profileId)?.process === child) {
        this.running.delete(profileId);
      }
    });

    this.running.set(profileId, preview);
    await waitForServer(port);
    this.logger.info(`[preview] serving ${paths.root} at ${preview.url}`);
    return preview;
  }

  async stop(profileId: string): Promise<void> {
    const preview = this.running.get(profileId);
    if (!preview) {
      return;
    }
    this.running.delete(profileId);
    // Wait for the process to be gone rather than just signalled: on Windows the
    // file handles it holds outlive kill() briefly, and deleting the site right
    // after would fail with EBUSY.
    await new Promise<void>((resolve) => {
      const done = (): void => resolve();
      const timer = setTimeout(() => {
        preview.process.kill();
        resolve();
      }, 4000);
      preview.process.once('exit', () => {
        clearTimeout(timer);
        done();
      });
      preview.process.kill();
    });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((id) => this.stop(id)));
  }
}

/** Wait until the port actually answers, so we never open a browser too early. */
function waitForServer(port: number, timeoutMs = 15000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          reject(new Error('the preview server did not start in time'));
          return;
        }
        setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}
