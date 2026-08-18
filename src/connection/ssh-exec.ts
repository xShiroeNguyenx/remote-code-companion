import { Client } from 'ssh2';
import { RccError } from '../core/errors';
import { Logger } from '../core/logger';
import { ServerProfile } from '../profiles/types';
import { RemoteCredentials } from './types';

/**
 * Run a command over SSH. Used for one job only: asking the server to dump its own
 * database, which no file-transfer protocol can do.
 *
 * A separate short-lived connection rather than the pooled SFTP session, because
 * a dump can take minutes and must not block browsing or saving in the meantime.
 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function sshExec(
  profile: ServerProfile,
  credentials: RemoteCredentials,
  command: string,
  logger: Logger,
  timeoutMs = 10 * 60 * 1000
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        client.end();
      } catch {
        // already gone
      }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new RccError('ConnectionFailed', `the command timed out after ${Math.round(timeoutMs / 1000)}s`))),
      timeoutMs
    );

    client.on('ready', () => {
      // Never log the command itself: it carries the database password.
      logger.info('[ssh] connected, running remote command');
      client.exec(command, (err, stream) => {
        if (err) {
          finish(() => reject(err));
          return;
        }
        let stdout = '';
        let stderr = '';
        let code = 0;
        stream.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        stream.on('exit', (exitCode: number | null) => {
          code = exitCode ?? 0;
        });
        stream.on('close', () => finish(() => resolve({ code, stdout, stderr })));
      });
    });

    client.on('error', (err) => finish(() => reject(err)));

    client.connect({
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: credentials.password,
      privateKey: credentials.privateKey,
      passphrase: credentials.passphrase,
      readyTimeout: 20000
    });
  });
}

/** Quote a value for a POSIX shell, so passwords with punctuation survive. */
export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}
