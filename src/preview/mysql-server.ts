import { ChildProcess, spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { formatError, Logger } from '../core/logger';

/**
 * A MySQL/MariaDB instance owned by the extension: its own data directory, its own
 * port, started and stopped with the preview.
 *
 * Deliberately *not* the user's existing server. Reusing that would mean asking
 * them to start XAMPP, sharing a port, and creating databases next to whatever
 * else they keep there — and stopping it on exit could kill work in another
 * project. A private instance can be torn down without asking who else needs it.
 */
export interface MysqlBinaries {
  mysqld: string;
  mysql: string;
  mysqladmin: string;
  installDb?: string;
}

export interface MysqlInstance {
  port: number;
  dataDir: string;
  process?: ChildProcess;
}

const WINDOWS_BIN_DIRS = ['C:/xampp/mysql/bin', 'C:/laragon/bin/mysql', 'C:/wamp64/bin/mariadb', 'C:/Program Files/MariaDB/bin', 'C:/Program Files/MySQL/MySQL Server 8.0/bin'];
const UNIX_BIN_DIRS = ['/usr/bin', '/usr/local/bin', '/usr/local/mysql/bin', '/opt/homebrew/bin', '/opt/homebrew/opt/mariadb/bin'];

function exeName(base: string): string {
  return process.platform === 'win32' ? base + '.exe' : base;
}

/** Look for a server plus the client tools needed to import and shut down. */
export function findMysql(configuredDir: string | undefined, logger: Logger): MysqlBinaries | undefined {
  const dirs = [
    ...(configuredDir && configuredDir.trim() ? [configuredDir.trim()] : []),
    ...(process.platform === 'win32' ? WINDOWS_BIN_DIRS : UNIX_BIN_DIRS)
  ];
  for (const dir of dirs) {
    const mysqld = path.join(dir, exeName('mysqld'));
    const mysql = path.join(dir, exeName('mysql'));
    const mysqladmin = path.join(dir, exeName('mysqladmin'));
    if (!fs.existsSync(mysqld) || !fs.existsSync(mysql)) {
      continue;
    }
    // MariaDB on Windows ships mysql_install_db; MySQL uses `mysqld --initialize`.
    const installDb = [exeName('mysql_install_db'), exeName('mariadb-install-db')]
      .map((name) => path.join(dir, name))
      .find((candidate) => fs.existsSync(candidate));
    logger.info(`[mysql] using ${mysqld}${installDb ? '' : ' (no mysql_install_db; will use --initialize-insecure)'}`);
    return { mysqld, mysql, mysqladmin, installDb };
  }
  return undefined;
}

export function findFreePort(from: number, attempts = 40): Promise<number> {
  const tryPort = (port: number, left: number): Promise<number> =>
    new Promise((resolve, reject) => {
      if (left <= 0) {
        reject(new Error('no free port for the preview database'));
        return;
      }
      const probe = net.createServer();
      probe.once('error', () => {
        probe.close();
        tryPort(port + 1, left - 1).then(resolve, reject);
      });
      probe.once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, '127.0.0.1');
    });
  return tryPort(from, attempts);
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const attempt = (): void => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

export class MysqlServer {
  private instance: MysqlInstance | undefined;

  constructor(
    private readonly binaries: MysqlBinaries,
    private readonly logger: Logger
  ) {}

  get port(): number | undefined {
    return this.instance?.port;
  }

  isRunning(): boolean {
    return this.instance !== undefined;
  }

  /** Create the system tables, once per data directory. */
  private initialise(dataDir: string, report: (m: string) => void): void {
    if (fs.existsSync(path.join(dataDir, 'mysql'))) {
      return;
    }
    report('Preparing the local database...');
    fs.mkdirSync(dataDir, { recursive: true });
    const posix = dataDir.split(path.sep).join('/');
    const result = this.binaries.installDb
      ? spawnSync(this.binaries.installDb, [`--datadir=${posix}`], {
          encoding: 'utf8',
          windowsHide: true,
          cwd: path.dirname(this.binaries.installDb)
        })
      : spawnSync(this.binaries.mysqld, ['--no-defaults', `--datadir=${posix}`, '--initialize-insecure'], {
          encoding: 'utf8',
          windowsHide: true
        });
    if (!fs.existsSync(path.join(dataDir, 'mysql'))) {
      throw new Error(
        `could not initialise the local database: ${(result.stderr || result.stdout || '').trim().slice(-400)}`
      );
    }
  }

  async start(dataDir: string, port: number, report: (m: string) => void): Promise<MysqlInstance> {
    if (this.instance) {
      return this.instance;
    }
    this.initialise(dataDir, report);
    report('Starting the local database...');
    const child = spawn(
      this.binaries.mysqld,
      [
        // --no-defaults so a my.ini elsewhere on the machine cannot change the
        // port, the data directory, or anything else about this instance.
        '--no-defaults',
        `--datadir=${dataDir.split(path.sep).join('/')}`,
        `--port=${port}`,
        '--bind-address=127.0.0.1',
        // Local throwaway data, reachable only from this machine: skipping the
        // grant tables avoids inventing and storing a password for it.
        '--skip-grant-tables',
        '--console'
      ],
      { windowsHide: true, cwd: path.dirname(this.binaries.mysqld) }
    );
    let log = '';
    child.stdout?.on('data', (d) => (log += String(d)));
    child.stderr?.on('data', (d) => {
      log += String(d);
      for (const line of String(d).split(/\r?\n/)) {
        if (/\[ERROR\]/i.test(line)) {
          this.logger.warn(`[mysql] ${line.trim()}`);
        }
      }
    });
    child.on('exit', (code) => {
      this.logger.info(`[mysql] server exited (code ${code ?? 'null'})`);
      if (this.instance?.process === child) {
        this.instance = undefined;
      }
    });

    const up = await waitForPort(port, 30000);
    if (!up) {
      child.kill();
      throw new Error(`the local database did not start: ${log.trim().slice(-500)}`);
    }
    this.instance = { port, dataDir, process: child };
    this.logger.info(`[mysql] listening on 127.0.0.1:${port} (data in ${dataDir})`);
    return this.instance;
  }

  private clientArgs(extra: string[]): string[] {
    return [
      '--protocol=TCP',
      '-h',
      '127.0.0.1',
      '-P',
      String(this.instance?.port ?? 0),
      '-u',
      'root',
      // The instance has no TLS material and needs none on loopback.
      '--skip-ssl',
      ...extra
    ];
  }

  query(sql: string): { code: number; output: string } {
    const result = spawnSync(this.binaries.mysql, this.clientArgs(['-e', sql]), {
      encoding: 'utf8',
      windowsHide: true
    });
    return { code: result.status ?? -1, output: (result.stdout || '') + (result.stderr || '') };
  }

  /**
   * One value from one query. The -N and -B flags ask the client for
   * tab-separated output with no header, so a result can be read directly rather
   * than scraped out of the table the client would otherwise draw.
   */
  scalar(sql: string): string | undefined {
    const result = spawnSync(this.binaries.mysql, this.clientArgs(['-N', '-B', '-e', sql]), {
      encoding: 'utf8',
      windowsHide: true
    });
    if ((result.status ?? -1) !== 0) {
      return undefined;
    }
    const first = (result.stdout || '')
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);
    return first?.split('\t')[0]?.trim();
  }

  recreateDatabase(name: string): void {
    const result = this.query(
      `DROP DATABASE IF EXISTS \`${name}\`; CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
    );
    if (result.code !== 0) {
      throw new Error(`could not create the local database: ${result.output.trim().slice(0, 300)}`);
    }
  }

  /** Stream a .sql file into the database. Dumps are far too large for a CLI argument. */
  importDump(database: string, sqlFile: string): void {
    const stream = fs.readFileSync(sqlFile);
    const result = spawnSync(this.binaries.mysql, this.clientArgs([database]), {
      input: stream,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 256 * 1024 * 1024
    });
    if ((result.status ?? -1) !== 0) {
      throw new Error(`importing the database failed: ${(result.stderr || '').trim().slice(0, 400)}`);
    }
  }

  async stop(): Promise<void> {
    const instance = this.instance;
    if (!instance) {
      return;
    }
    this.instance = undefined;
    // A clean shutdown flushes InnoDB; killing the process would leave the data
    // directory needing recovery on the next start.
    try {
      spawnSync(this.binaries.mysqladmin, [
        '--protocol=TCP',
        '-h',
        '127.0.0.1',
        '-P',
        String(instance.port),
        '-u',
        'root',
        '--skip-ssl',
        'shutdown'
      ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    } catch (err) {
      this.logger.warn(`[mysql] clean shutdown failed: ${formatError(err)}`);
    }
    if (instance.process && !instance.process.killed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          instance.process?.kill();
          resolve();
        }, 8000);
        instance.process?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

/**
 * One database server shared by every preview in this window, with a database per
 * profile. Started on first use and stopped with the window, so a user who never
 * clones a database never pays for a running server.
 */
export class LocalDatabase {
  private server: MysqlServer | undefined;

  constructor(
    private readonly storageDir: string,
    private readonly logger: Logger,
    private readonly configuredBinDir: () => string | undefined
  ) {}

  available(): boolean {
    return findMysql(this.configuredBinDir(), this.logger) !== undefined;
  }

  isRunning(): boolean {
    return this.server?.isRunning() ?? false;
  }

  get port(): number | undefined {
    return this.server?.port;
  }

  async ensureRunning(report: (message: string) => void): Promise<MysqlServer> {
    if (this.server?.isRunning()) {
      return this.server;
    }
    const binaries = findMysql(this.configuredBinDir(), this.logger);
    if (!binaries) {
      throw new Error(
        'No MySQL or MariaDB found on this machine. Install one (XAMPP includes MariaDB), or set remoteCodeCompanion.mysql.binDir to the folder holding mysqld.'
      );
    }
    const server = new MysqlServer(binaries, this.logger);
    const dataDir = path.join(this.storageDir, 'preview', 'mysql-data');
    const port = await findFreePort(33060);
    await server.start(dataDir, port, report);
    this.server = server;
    return server;
  }

  async stop(): Promise<void> {
    await this.server?.stop();
    this.server = undefined;
  }
}
