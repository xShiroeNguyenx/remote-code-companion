import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { ManagedConnection } from '../connection/connection-manager';
import { shellQuote, sshExec } from '../connection/ssh-exec';
import { RemoteCredentials } from '../connection/types';
import { RccError } from '../core/errors';
import { formatError, Logger } from '../core/logger';
import { joinRemote } from '../core/remote-path';
import { RemoteConfig } from '../profiles/types';
import { looksLikeSqlDump, sanitiseDump } from './dump-sanitise';
import { MysqlServer } from './mysql-server';
import { parseWpConfig, WpDatabaseConfig } from './wp-config-parse';

/**
 * Copy production's database into the local preview.
 *
 * A *copy* is the whole point. Pointing a local WordPress at the live database
 * would have it writing transients, cron entries and option updates into
 * production on every page view — damage no file backup could undo, because none
 * of it is a file.
 *
 * The dump is produced on the server by mysqldump, because that is the only place
 * the database is reachable: shared hosts do not expose MySQL to the internet, and
 * no file-transfer protocol can read a database.
 */

export interface CloneOptions {
  config: RemoteConfig;
  credentials: RemoteCredentials;
  connection: ManagedConnection;
  mysql: MysqlServer;
  /** Local database to (re)create and fill. */
  databaseName: string;
  /** Where the downloaded dump is kept. */
  workDir: string;
  logger: Logger;
  report(message: string): void;
}

export interface CloneResult {
  database: WpDatabaseConfig;
  /** Size of the downloaded dump, for the summary. */
  bytes: number;
  tables: number;
}

/** Read production's wp-config.php through the existing connection. */
export async function readRemoteWpConfig(
  config: RemoteConfig,
  connection: ManagedConnection
): Promise<WpDatabaseConfig> {
  // wp-config.php normally sits at the WordPress root, which is the remote root
  // for a site pulled with this extension; try the parent too, since moving it one
  // level up is a common hardening step.
  const candidates = [joinRemote(config.remoteRoot, 'wp-config.php'), joinRemote(config.remoteRoot, '../wp-config.php')];
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const bytes = await connection.readFile(candidate);
      const parsed = parseWpConfig(bytes.toString('utf8'));
      if (parsed.config) {
        return parsed.config;
      }
      failures.push(`${candidate}: missing ${parsed.missing.join(', ')}`);
    } catch (err) {
      failures.push(`${candidate}: ${formatError(err)}`);
    }
  }
  throw new RccError(
    'FileNotFound',
    `Could not read the database settings from wp-config.php.\n${failures.join('\n')}`
  );
}

/**
 * Ask the server to dump its own database, then download it.
 *
 * The password is passed through an environment variable, never on the command
 * line, so it cannot show up in the server's process list for other tenants of the
 * same shared host to read.
 */
export async function dumpRemoteDatabase(options: CloneOptions, database: WpDatabaseConfig): Promise<string> {
  const { config, credentials, connection, workDir, logger, report } = options;
  const remoteTemp = joinRemote(config.remoteRoot, `rcc-dump-${Date.now()}.sql.gz`);

  const command = [
    `MYSQL_PWD=${shellQuote(database.password)}`,
    'mysqldump',
    `-h ${shellQuote(database.host.split(':')[0] || 'localhost')}`,
    `-u ${shellQuote(database.user)}`,
    // Keep the dump portable and quick to import: no locking on a live site, and
    // no stored routines that a preview does not need.
    '--single-transaction',
    '--quick',
    '--skip-lock-tables',
    '--no-tablespaces',
    '--default-character-set=utf8mb4',
    shellQuote(database.name),
    `| gzip -c > ${shellQuote(remoteTemp)}`
  ].join(' ');

  report('Dumping the database on the server...');
  const result = await sshExec(config, credentials, command, logger);
  if (result.code !== 0) {
    // Clean up even on failure: a half-written dump must not be left in a
    // web-accessible directory.
    await removeRemote(connection, remoteTemp, logger);
    throw new RccError(
      'Unavailable',
      `mysqldump failed on the server (exit ${result.code}). ${result.stderr.trim().slice(0, 400)}`
    );
  }

  report('Downloading the dump...');
  let bytes: Buffer;
  try {
    bytes = await connection.readFile(remoteTemp);
  } finally {
    // The dump contains the whole site's data; it does not stay on the server.
    await removeRemote(connection, remoteTemp, logger);
  }

  fs.mkdirSync(workDir, { recursive: true });
  const localGz = path.join(workDir, 'dump.sql.gz');
  fs.writeFileSync(localGz, bytes);
  return localGz;
}

async function removeRemote(connection: ManagedConnection, remotePath: string, logger: Logger): Promise<void> {
  try {
    await connection.remove(remotePath, 'file');
  } catch (err) {
    logger.warn(`[clone] could not delete the temporary dump ${remotePath}: ${formatError(err)}`);
  }
}

/** Decompress with Node's zlib; the dump arrives gzipped to save transfer time. */
export function gunzipToFile(gzFile: string, sqlFile: string): void {
  fs.writeFileSync(sqlFile, zlib.gunzipSync(fs.readFileSync(gzFile)));
}

export async function cloneDatabase(options: CloneOptions): Promise<CloneResult> {
  const { connection, config, mysql, databaseName, workDir, logger, report } = options;

  report('Reading wp-config.php...');
  const database = await readRemoteWpConfig(config, connection);

  const gzFile = await dumpRemoteDatabase(options, database);
  const sqlFile = path.join(workDir, 'dump.sql');
  report('Unpacking the dump...');
  gunzipToFile(gzFile, sqlFile);

  let sql = fs.readFileSync(sqlFile, 'utf8');

  // A shell pipeline returns the status of its last command, so a failed
  // mysqldump still arrives as a perfectly valid gzip file. Check the content.
  const verdict = looksLikeSqlDump(sql);
  if (!verdict.ok) {
    throw new RccError('Unavailable', `The dump from the server is not usable: ${verdict.reason}`);
  }

  const cleaned = sanitiseDump(sql);
  if (cleaned.removed.length > 0) {
    logger.info(
      `[clone] removed ${cleaned.removed.length} directive(s) the local client cannot run: ${cleaned.removed.join(', ')}`
    );
    sql = cleaned.sql;
    fs.writeFileSync(sqlFile, sql, 'utf8');
  }
  const bytes = fs.statSync(sqlFile).size;

  report('Importing into the local database...');
  mysql.recreateDatabase(databaseName);
  mysql.importDump(databaseName, sqlFile);

  // Keep the compressed copy for a re-import, drop the expanded one.
  fs.rmSync(sqlFile, { force: true });

  const counted = mysql.scalar(
    `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${databaseName.replace(/'/g, '')}'`
  );
  const tables = Number(counted ?? 0);
  return { database, bytes, tables };
}
