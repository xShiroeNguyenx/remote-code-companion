'use strict';
// Integration test: spins up a real FTP server (ftp-srv) and a real SFTP server
// (ssh2's server API) in-process, then drives the compiled connection layer
// (ConnectionManager → FtpRemoteClient / SftpRemoteClient) end-to-end.
// No vscode involved — the connection layer is vscode-free by design.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FTP_PORT = 21721;
const SFTP_PORT = 21722;
const USER = 'test';
const PASS = 'pw';

const outDir = path.join(process.cwd(), 'out');
const { ConnectionManager, testProfileConnection } = require(path.join(outDir, 'connection', 'connection-manager.js'));

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m) => console.warn('  [warn]', m),
  error: (m, e) => console.error('  [error]', m, e || '')
};

// ---------------------------------------------------------------- FTP server

async function startFtpServer(rootDir) {
  const { FtpSrv } = require('ftp-srv');
  let log;
  try {
    const bunyan = require('bunyan');
    log = bunyan.createLogger({ name: 'ftp-srv', level: 'fatal' });
  } catch {
    log = undefined;
  }
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${FTP_PORT}`,
    pasv_url: '127.0.0.1',
    pasv_min: 21800,
    pasv_max: 21900,
    anonymous: false,
    log
  });
  server.on('login', ({ username, password }, resolve, reject) => {
    if (username === USER && password === PASS) {
      resolve({ root: rootDir });
    } else {
      reject(new Error('Invalid credentials'));
    }
  });
  await server.listen();
  return server;
}

// --------------------------------------------------------------- SFTP server

function startSftpServer(rootDir) {
  const { Server, utils } = require('ssh2');
  const { OPEN_MODE, STATUS_CODE } = utils.sftp;

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });

  const resolvePath = (p) => {
    const posix = path.posix.normalize(p === '.' || p === '' ? '/' : p);
    const abs = path.join(rootDir, posix.replace(/^\/+/, ''));
    if (!abs.startsWith(rootDir)) {
      throw new Error('path escape');
    }
    return abs;
  };

  const attrsFor = (stats) => ({
    mode: stats.mode,
    uid: 0,
    gid: 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000)
  });

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => undefined);
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) {
        ctx.accept();
      } else {
        ctx.reject(['password']);
      }
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          let handleCounter = 0;
          const handles = new Map(); // id -> { fd } | { dirPath, sent }

          const newHandle = (value) => {
            const id = handleCounter++;
            handles.set(id, value);
            const buf = Buffer.alloc(4);
            buf.writeUInt32BE(id, 0);
            return buf;
          };
          const getHandle = (buf) => handles.get(buf.readUInt32BE(0));

          const statusFromError = (err) =>
            err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')
              ? STATUS_CODE.NO_SUCH_FILE
              : STATUS_CODE.FAILURE;

          sftp.on('REALPATH', (reqid, givenPath) => {
            const norm = path.posix.normalize(givenPath === '.' || givenPath === '' ? '/' : givenPath);
            sftp.name(reqid, [{ filename: norm.startsWith('/') ? norm : '/' + norm, longname: norm, attrs: {} }]);
          });

          const doStat = (reqid, givenPath) => {
            try {
              const stats = fs.statSync(resolvePath(givenPath));
              sftp.attrs(reqid, attrsFor(stats));
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          };
          sftp.on('STAT', doStat);
          sftp.on('LSTAT', doStat);

          sftp.on('FSTAT', (reqid, handleBuf) => {
            const handle = getHandle(handleBuf);
            if (!handle || handle.fd === undefined) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            try {
              sftp.attrs(reqid, attrsFor(fs.fstatSync(handle.fd)));
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          });

          sftp.on('OPENDIR', (reqid, givenPath) => {
            try {
              const abs = resolvePath(givenPath);
              if (!fs.statSync(abs).isDirectory()) {
                sftp.status(reqid, STATUS_CODE.FAILURE);
                return;
              }
              sftp.handle(reqid, newHandle({ dirPath: abs, sent: false }));
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          });

          sftp.on('READDIR', (reqid, handleBuf) => {
            const handle = getHandle(handleBuf);
            if (!handle || handle.dirPath === undefined) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            if (handle.sent) {
              sftp.status(reqid, STATUS_CODE.EOF);
              return;
            }
            handle.sent = true;
            try {
              const names = fs.readdirSync(handle.dirPath);
              const entries = names.map((name) => {
                const stats = fs.statSync(path.join(handle.dirPath, name));
                const typeChar = stats.isDirectory() ? 'd' : '-';
                const longname = `${typeChar}rw-r--r--   1 owner  group ${String(stats.size).padStart(10)} Jan  1 00:00 ${name}`;
                return { filename: name, longname, attrs: attrsFor(stats) };
              });
              sftp.name(reqid, entries);
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          });

          sftp.on('OPEN', (reqid, filename, flags) => {
            try {
              let flagStr;
              if (flags & OPEN_MODE.WRITE) {
                flagStr = flags & OPEN_MODE.APPEND ? 'a' : 'w';
              } else {
                flagStr = 'r';
              }
              const fd = fs.openSync(resolvePath(filename), flagStr);
              sftp.handle(reqid, newHandle({ fd }));
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          });

          sftp.on('READ', (reqid, handleBuf, offset, length) => {
            const handle = getHandle(handleBuf);
            if (!handle || handle.fd === undefined) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            const buffer = Buffer.alloc(length);
            try {
              const bytesRead = fs.readSync(handle.fd, buffer, 0, length, offset);
              if (bytesRead === 0) {
                sftp.status(reqid, STATUS_CODE.EOF);
              } else {
                sftp.data(reqid, buffer.subarray(0, bytesRead));
              }
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          });

          sftp.on('WRITE', (reqid, handleBuf, offset, data) => {
            const handle = getHandle(handleBuf);
            if (!handle || handle.fd === undefined) {
              sftp.status(reqid, STATUS_CODE.FAILURE);
              return;
            }
            try {
              fs.writeSync(handle.fd, data, 0, data.length, offset);
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          });

          sftp.on('CLOSE', (reqid, handleBuf) => {
            const handle = getHandle(handleBuf);
            if (handle && handle.fd !== undefined) {
              try {
                fs.closeSync(handle.fd);
              } catch {
                // ignore
              }
            }
            handles.delete(handleBuf.readUInt32BE(0));
            sftp.status(reqid, STATUS_CODE.OK);
          });

          sftp.on('REMOVE', (reqid, givenPath) => {
            try {
              fs.unlinkSync(resolvePath(givenPath));
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          });

          sftp.on('RENAME', (reqid, oldPath, newPath) => {
            try {
              fs.renameSync(resolvePath(oldPath), resolvePath(newPath));
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          });

          sftp.on('MKDIR', (reqid, givenPath) => {
            try {
              fs.mkdirSync(resolvePath(givenPath));
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          });

          sftp.on('RMDIR', (reqid, givenPath) => {
            try {
              fs.rmdirSync(resolvePath(givenPath));
              sftp.status(reqid, STATUS_CODE.OK);
            } catch (err) {
              sftp.status(reqid, statusFromError(err));
            }
          });

          const okStat = (reqid) => sftp.status(reqid, STATUS_CODE.OK);
          sftp.on('SETSTAT', (reqid) => okStat(reqid));
          sftp.on('FSETSTAT', (reqid) => okStat(reqid));
        });
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(SFTP_PORT, '127.0.0.1', () => resolve(server));
  });
}

// ------------------------------------------------------------------- helpers

function makeProfile(overrides) {
  return Object.assign(
    {
      id: 'ab12cd34',
      name: 'integration',
      protocol: 'ftp',
      host: '127.0.0.1',
      port: FTP_PORT,
      username: USER,
      auth: 'password',
      remoteRoot: '/',
      readOnly: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    },
    overrides
  );
}

async function exercise(label, manager, profileId, serverRoot) {
  console.log(`\n[${label}]`);
  const conn = manager.getConnection(profileId);

  // mkdir
  await conn.mkdir('/it-dir');
  assert.ok(fs.existsSync(path.join(serverRoot, 'it-dir')), 'mkdir did not create the directory');
  console.log('  mkdir OK');

  // create file
  const contentV1 = Buffer.from('hello world');
  await conn.writeFile('/it-dir/hello.txt', contentV1);
  assert.strictEqual(fs.readFileSync(path.join(serverRoot, 'it-dir', 'hello.txt'), 'utf8'), 'hello world');
  console.log('  writeFile (create) OK');

  // list
  const listing = await conn.list('/it-dir');
  const found = listing.find((e) => e.name === 'hello.txt');
  assert.ok(found, 'listing must contain hello.txt');
  assert.strictEqual(found.type, 'file');
  assert.strictEqual(found.size, contentV1.length);
  console.log(`  list OK (mtimeSource=${found.mtimeSource})`);

  // stat
  const stat1 = await conn.stat('/it-dir/hello.txt');
  assert.strictEqual(stat1.size, contentV1.length);
  assert.strictEqual(stat1.type, 'file');
  assert.ok(stat1.mtimeMs === undefined || stat1.mtimeMs > 0, 'mtime should be positive when present');
  console.log(`  stat OK (mtimeSource=${stat1.mtimeSource})`);

  // read round-trip
  const readBack = await conn.readFile('/it-dir/hello.txt');
  assert.strictEqual(readBack.toString('utf8'), 'hello world');
  console.log('  readFile OK');

  // unicode content + name
  const uniName = '/it-dir/xin chào.txt';
  await conn.writeFile(uniName, Buffer.from('nội dung tiếng Việt'));
  const uniBack = await conn.readFile(uniName);
  assert.strictEqual(uniBack.toString('utf8'), 'nội dung tiếng Việt');
  console.log('  unicode name/content OK');

  // overwrite + cache invalidation (list again must show the new size)
  const contentV2 = Buffer.from('hello world v2');
  await conn.writeFile('/it-dir/hello.txt', contentV2);
  const stat2 = await conn.stat('/it-dir/hello.txt');
  assert.strictEqual(stat2.size, contentV2.length, 'stat after overwrite must reflect the new size (cache invalidation)');
  console.log('  overwrite + cache invalidation OK');

  // rename
  await conn.rename('/it-dir/hello.txt', '/it-dir/renamed.txt');
  const afterRename = await conn.list('/it-dir');
  assert.ok(afterRename.some((e) => e.name === 'renamed.txt'), 'renamed file must appear');
  assert.ok(!afterRename.some((e) => e.name === 'hello.txt'), 'old name must be gone');
  console.log('  rename OK');

  // stat on a missing file must throw FileNotFound
  let notFound = false;
  try {
    await conn.stat('/it-dir/definitely-missing.txt');
  } catch (err) {
    notFound = err && (err.code === 'FileNotFound' || /not found|no such file/i.test(String(err.message)));
  }
  assert.ok(notFound, 'stat of a missing file must fail with FileNotFound');
  console.log('  stat missing → FileNotFound OK');

  // delete file + dir
  await conn.remove('/it-dir/renamed.txt', 'file');
  await conn.remove(uniName, 'file');
  await conn.remove('/it-dir', 'directory');
  assert.ok(!fs.existsSync(path.join(serverRoot, 'it-dir')), 'directory must be deleted on the server');
  console.log('  delete file + directory OK');

  // serialized queue: 5 concurrent ops on one connection must all succeed
  await conn.mkdir('/queue-dir');
  await Promise.all(
    [0, 1, 2, 3, 4].map((i) => conn.writeFile(`/queue-dir/f${i}.txt`, Buffer.from(`file ${i}`)))
  );
  const queued = await conn.list('/queue-dir');
  assert.strictEqual(queued.length, 5, 'all queued writes must land');
  for (let i = 0; i < 5; i++) {
    await conn.remove(`/queue-dir/f${i}.txt`, 'file');
  }
  await conn.remove('/queue-dir', 'directory');
  console.log('  concurrent ops serialized OK');
}

async function main() {
  const ftpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-it-ftp-'));
  const sftpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-it-sftp-'));

  console.log('starting in-process FTP + SFTP servers...');
  const ftpServer = await startFtpServer(ftpRoot);
  const sftpServer = await startSftpServer(sftpRoot);

  const ftpProfile = makeProfile({ id: 'ab12cd34', protocol: 'ftp', port: FTP_PORT });
  const sftpProfile = makeProfile({ id: 'ef56ab78', protocol: 'sftp', port: SFTP_PORT });
  const profiles = new Map([
    [ftpProfile.id, ftpProfile],
    [sftpProfile.id, sftpProfile]
  ]);

  const manager = new ConnectionManager({
    getProfile: (id) => profiles.get(id),
    getCredentials: async () => ({ password: PASS }),
    logger,
    idleTimeoutMs: () => 60000
  });

  let failed = false;
  try {
    await exercise('FTP  (ftp-srv)', manager, ftpProfile.id, ftpRoot);
    await exercise('SFTP (ssh2)', manager, sftpProfile.id, sftpRoot);

    // testProfileConnection: good and bad credentials
    const good = await testProfileConnection(ftpProfile, { password: PASS }, logger);
    assert.strictEqual(good.ok, true, `testProfileConnection should succeed: ${good.error}`);
    const bad = await testProfileConnection(ftpProfile, { password: 'wrong' }, logger);
    assert.strictEqual(bad.ok, false, 'testProfileConnection must fail with wrong password');
    console.log('\n[testProfileConnection] good + bad credentials OK');

    console.log('\nintegration-test OK');
  } catch (err) {
    failed = true;
    console.error('\nintegration-test FAILED');
    console.error(err);
  } finally {
    try {
      await manager.disconnectAll();
    } catch {
      // ignore
    }
    try {
      await ftpServer.close();
    } catch {
      // ignore
    }
    try {
      sftpServer.close();
    } catch {
      // ignore
    }
    fs.rmSync(ftpRoot, { recursive: true, force: true });
    fs.rmSync(sftpRoot, { recursive: true, force: true });
  }
  // ftp-srv keeps sockets alive; exit explicitly.
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
