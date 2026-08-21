'use strict';
// Integration test for M7: pull / push / conflict against a real in-process FTP
// server, driving the compiled SyncEngine wired to the real save pipeline.
//
// Writes go out through RemoteFsProvider (the mocked workspace.fs routes to it),
// so a push here exercises conflict check → backup → confirmation → upload →
// verification exactly as Ctrl+S does.
//
// The case worth the whole file: a cancelled confirmation must leave the file
// still pending and the server untouched. If the baseline advanced there, the
// extension would quietly claim a deploy that never happened.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installVscodeMock } = require('./vscode-mock');

const FTP_PORT = 21771;
const USER = 'wp';
const PASS = 'secret';
const PROFILE_ID = 'ab12cd34';

const outDir = path.join(process.cwd(), 'out');
const req = (rel) => require(path.join(outDir, rel));

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (m) => console.warn('  [warn]', m),
  error: (m, e) => console.error('  [error]', m, e || '')
};

// --------------------------------------------------------------------- server

async function startFtp(rootDir) {
  const { FtpSrv } = require('ftp-srv');
  let log;
  try {
    log = require('bunyan').createLogger({ name: 'ftp-srv', level: 'fatal' });
  } catch {
    log = undefined;
  }
  const server = new FtpSrv({
    url: `ftp://127.0.0.1:${FTP_PORT}`,
    pasv_url: '127.0.0.1',
    pasv_min: 21780,
    pasv_max: 21830,
    anonymous: false,
    log
  });
  server.on('login', ({ username, password }, resolve, reject) => {
    if (username === USER && password === PASS) {
      resolve({ root: rootDir });
    } else {
      reject(new Error('bad credentials'));
    }
  });
  await server.listen();
  return server;
}

// ---------------------------------------------------------------------- setup

function writeServerFixture(root) {
  const files = {
    'wp-content/themes/mytheme/style.css': 'body { color: red }\n',
    'wp-content/themes/mytheme/functions.php': '<?php // v1\n',
    'wp-content/themes/mytheme/assets/app.js': 'console.log(1)\n',
    'wp-content/themes/mytheme/screenshot.png': 'PNGDATA',
    'wp-admin/admin.php': '<?php // core\n'
  };
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  fs.writeFileSync(path.join(root, 'wp-content/themes/mytheme/huge.css'), 'a'.repeat(80 * 1024));
}

function writeConfig(folderRoot) {
  fs.mkdirSync(path.join(folderRoot, '.rcc'), { recursive: true });
  fs.writeFileSync(
    path.join(folderRoot, '.rcc', 'config.json'),
    JSON.stringify(
      {
        version: 1,
        id: PROFILE_ID,
        name: 'TestSite',
        protocol: 'ftp',
        host: '127.0.0.1',
        port: FTP_PORT,
        username: USER,
        auth: 'password',
        remoteRoot: '/',
        readOnly: false,
        roots: [],
        excludes: ['wp-admin', '**/*.png'],
        maxFileSizeKB: 32
      },
      null,
      2
    ),
    'utf8'
  );
}

/** Build the same object graph activate() builds, but under test control. */
function buildStack(vscode, folder) {
  const { RemoteConfigStore } = req('profiles/remote-config-store.js');
  const { ConnectionManager } = req('connection/connection-manager.js');
  const { FileStateTracker } = req('fs/file-state-tracker.js');
  const { BackupManager } = req('backup/backup-manager.js');
  const { SavePipeline } = req('save/save-pipeline.js');
  const { RemoteFsProvider } = req('fs/remote-fs-provider.js');
  const { SyncEngine } = req('mirror/sync-engine.js');

  const store = new RemoteConfigStore(logger);
  const tracker = new FileStateTracker();
  const backups = new BackupManager((id) => store.backupDirFor(id), logger, () => ({
    maxPerFile: 10,
    maxAgeDays: 30
  }));
  const manager = new ConnectionManager({
    getProfile: (id) => store.get(id),
    getCredentials: async () => ({ password: PASS }),
    logger,
    idleTimeoutMs: () => 600000
  });
  const pipeline = new SavePipeline({ tracker, backups, logger });
  const fsProvider = new RemoteFsProvider({ profiles: store, manager, tracker, pipeline, backups, logger });
  vscode.workspace.registerFileSystemProvider('rcc', fsProvider);
  const engine = new SyncEngine({ store, manager, tracker, pipeline, logger });
  const { registerUploadCommands } = req('mirror/upload-commands.js');
  registerUploadCommands({ store, engine, logger });
  void folder;
  return { store, manager, engine, backups };
}

const stateOf = (statuses, rel) => statuses.find((s) => s.localRelPath === rel)?.state;

async function main() {
  const vscode = installVscodeMock();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-sync-'));
  const serverRoot = path.join(tmp, 'server');
  const folderRoot = path.join(tmp, 'folder');
  fs.mkdirSync(serverRoot, { recursive: true });
  fs.mkdirSync(folderRoot, { recursive: true });
  writeServerFixture(serverRoot);
  writeConfig(folderRoot);

  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(folderRoot), name: 'folder', index: 0 }];

  const server = await startFtp(serverRoot);
  const { store, manager, engine, backups } = buildStack(vscode, folderRoot);
  await store.reload();
  const config = store.get(PROFILE_ID);
  assert.ok(config, 'config should load from .rcc/config.json');

  const localPath = (rel) => path.join(folderRoot, rel.split('/').join(path.sep));
  const serverPath = (rel) => path.join(serverRoot, rel.split('/').join(path.sep));
  const THEME = '/wp-content/themes/mytheme';
  const STYLE = 'wp-content/themes/mytheme/style.css';

  try {
    // ---------------------------------------------------------------- 1. pull
    const scan = await engine.scanPull(config, THEME);
    const accepted = scan.candidates;
    const result = await engine.pull(config, scan, accepted);

    assert.strictEqual(result.pulled.length, 3, `expected 3 files pulled, got ${result.pulled.join(', ')}`);
    assert.ok(fs.existsSync(localPath(STYLE)), 'style.css should be on disk');
    assert.ok(fs.existsSync(localPath('wp-content/themes/mytheme/assets/app.js')), 'nested file should be on disk');
    assert.ok(!fs.existsSync(localPath('wp-content/themes/mytheme/screenshot.png')), 'png is excluded');
    assert.ok(!fs.existsSync(localPath('wp-content/themes/mytheme/huge.css')), 'oversized file is skipped');
    assert.ok(!fs.existsSync(localPath('wp-admin')), 'wp-admin is excluded');
    console.log('  pull: 3 source files mirrored, png/oversized/core skipped OK');

    // Paths mirror the server rather than being flattened.
    assert.strictEqual(
      fs.readFileSync(localPath(STYLE), 'utf8'),
      fs.readFileSync(serverPath(STYLE), 'utf8'),
      'pulled content must match the server'
    );

    // ------------------------------------------------------ 2. clean status
    let statuses = await engine.status(config);
    assert.ok(
      statuses.every((s) => s.state === 'inSync'),
      `everything should be in sync, got ${JSON.stringify(statuses.map((s) => [s.localRelPath, s.state]))}`
    );
    assert.strictEqual(engine.pendingCount(PROFILE_ID), 0, 'nothing pending after a pull');
    console.log('  status: clean after pull, 0 pending OK');

    // ------------------------------------------------- 3. local edit pending
    fs.writeFileSync(localPath(STYLE), 'body { color: blue }\n');
    statuses = await engine.status(config);
    assert.strictEqual(stateOf(statuses, STYLE), 'localChanged');
    assert.strictEqual(engine.pendingCount(PROFILE_ID), 1, 'the edited file is pending');
    console.log('  status: local edit → localChanged, 1 pending OK');

    // --------------------------------------- 4. cancelled push changes nothing
    vscode.__answer.dialog = undefined; // the user dismisses the confirmation
    let push = await engine.push(config, statuses.filter((s) => s.state === 'localChanged'));
    assert.strictEqual(push.outcomes[0].outcome, 'cancelled', 'dismissing the dialog must read as cancelled');
    assert.strictEqual(
      fs.readFileSync(serverPath(STYLE), 'utf8'),
      'body { color: red }\n',
      'a cancelled push must not touch the server'
    );
    statuses = await engine.status(config);
    assert.strictEqual(
      stateOf(statuses, STYLE),
      'localChanged',
      'after a cancel the file must still be pending, not silently "synced"'
    );
    assert.strictEqual(engine.pendingCount(PROFILE_ID), 1);
    console.log('  push cancelled: server untouched, file still pending OK');

    // ------------------------------------------------- 5. confirmed push works
    vscode.__answer.dialog = 'upload';
    push = await engine.push(config, statuses.filter((s) => s.state === 'localChanged'));
    assert.strictEqual(push.outcomes[0].outcome, 'pushed');
    assert.strictEqual(
      fs.readFileSync(serverPath(STYLE), 'utf8'),
      'body { color: blue }\n',
      'the server should now hold the local content'
    );
    statuses = await engine.status(config);
    assert.strictEqual(stateOf(statuses, STYLE), 'inSync', 'baseline should advance after a verified push');
    assert.strictEqual(engine.pendingCount(PROFILE_ID), 0);

    // The pipeline kept a copy of what it overwrote.
    const entries = await backups.listForFile(PROFILE_ID, '/' + STYLE);
    assert.ok(entries.length >= 1, 'a pre-save backup must exist');
    assert.strictEqual((await backups.read(entries[0])).toString(), 'body { color: red }\n');
    console.log('  push confirmed: server updated, baseline advanced, backup kept OK');

    // -------------------------------------------------- 6. server-side change
    fs.writeFileSync(serverPath(STYLE), 'body { color: green; padding: 0 }\n');
    manager.getConnection(PROFILE_ID).invalidateAll();
    statuses = await engine.status(config);
    assert.strictEqual(stateOf(statuses, STYLE), 'remoteChanged', 'a server edit should ask to be pulled');
    console.log('  status: server-side edit → remoteChanged OK');

    // ------------------------------------------------------ 7. both sides edit
    fs.writeFileSync(localPath(STYLE), 'body { color: black }\n');
    statuses = await engine.status(config);
    assert.strictEqual(stateOf(statuses, STYLE), 'bothChanged', 'edits on both sides must be a conflict');

    // A conflict is never pushed, even when explicitly handed to push().
    vscode.__answer.dialog = 'upload';
    push = await engine.push(config, statuses.filter((s) => s.localRelPath === STYLE));
    assert.strictEqual(push.outcomes[0].outcome, 'skipped', 'a conflict must be refused, not resolved');
    assert.strictEqual(
      fs.readFileSync(serverPath(STYLE), 'utf8'),
      'body { color: green; padding: 0 }\n',
      'the conflicted push must not have written'
    );
    console.log('  conflict: both sides changed → refused by push OK');

    // ------------------------------------------- 8. take-server resolves it
    await engine.takeServer(config, statuses.find((s) => s.localRelPath === STYLE));
    assert.strictEqual(
      fs.readFileSync(localPath(STYLE), 'utf8'),
      'body { color: green; padding: 0 }\n',
      'taking the server version should overwrite the local copy'
    );
    statuses = await engine.status(config);
    assert.strictEqual(stateOf(statuses, STYLE), 'inSync');
    console.log('  conflict: take-server restores in-sync state OK');

    // --------------------------------------------------- 9. new local file
    const NEWFILE = 'wp-content/themes/mytheme/new.php';
    fs.writeFileSync(localPath(NEWFILE), '<?php // brand new\n');
    statuses = await engine.status(config);
    assert.strictEqual(stateOf(statuses, NEWFILE), 'created', 'an untracked local file is a creation');

    vscode.__answer.dialog = 'upload';
    push = await engine.push(config, statuses.filter((s) => s.localRelPath === NEWFILE));
    assert.strictEqual(push.outcomes[0].outcome, 'pushed');
    assert.ok(fs.existsSync(serverPath(NEWFILE)), 'the new file should now exist on the server');
    console.log('  created: new local file pushed as a create OK');

    // ---------------------------------------------- 10. server-side deletion
    fs.unlinkSync(serverPath(NEWFILE));
    manager.getConnection(PROFILE_ID).invalidateAll();
    statuses = await engine.status(config);
    assert.strictEqual(stateOf(statuses, NEWFILE), 'remoteMissing', 'a server deletion should be reported, not re-pushed');
    console.log('  status: server-side delete → remoteMissing OK');

    // ------------------------------------------ 11. a second pull is resumable
    // Shared hosts drop long transfers; re-running Pull must fetch only what is
    // missing rather than downloading the whole subtree again.
    manager.getConnection(PROFILE_ID).invalidateAll();
    const rescan = await engine.scanPull(config, THEME);
    assert.ok(rescan.candidates.length >= 3, 'the theme files should still be candidates');
    assert.ok(
      rescan.candidates.every((c) => c.alreadyCurrent),
      `every unchanged file should be marked already-current, got ${JSON.stringify(
        rescan.candidates.map((c) => [c.localRelPath, c.alreadyCurrent])
      )}`
    );
    const second = await engine.pull(config, rescan, rescan.candidates);
    assert.strictEqual(second.pulled.length, 0, 'nothing should be re-downloaded');
    assert.strictEqual(second.bytes, 0, 'a resumed pull with nothing missing transfers no bytes');
    assert.ok(
      second.skipped.some((s) => s.reason === 'already up to date' && s.items.length >= 3),
      'the skip reason should say the files were already current'
    );
    assert.strictEqual(second.aborted, undefined, 'a clean pull must not report an abort');
    console.log('  pull again: nothing re-downloaded, resumable OK');

    // ------------------------- 12. a whole new directory, created locally
    // A new directory is only noticed inside a synced subtree: the extension never
    // scans the whole workspace. Declaring the subtree is what a Pull of
    // wp-content/plugins would have done, so the test starts by doing that.
    const pluginsRoot = '/wp-content/plugins';
    await store.write(store.folderFor(PROFILE_ID), {
      ...store.get(PROFILE_ID),
      roots: [...store.get(PROFILE_ID).roots, pluginsRoot]
    });
    const withPlugins = store.get(PROFILE_ID);
    assert.ok(withPlugins.roots.includes(pluginsRoot), 'the plugins subtree should be declared');
    // The real case: a new plugin folder added in the workspace. Neither FTP nor
    // SFTP creates parent directories on write, so without an explicit mkdir the
    // upload fails with a bare "no such file" and the folder never appears.
    const NEWDIR = 'wp-content/plugins/my-custom-plugin';
    fs.mkdirSync(localPath(NEWDIR), { recursive: true });
    fs.writeFileSync(localPath(NEWDIR + '/plugin.php'), '<?php // brand new plugin' + String.fromCharCode(10));
    fs.writeFileSync(localPath(NEWDIR + '/readme.txt'), 'notes' + String.fromCharCode(10));

    // The directory must not exist on the server yet, or the test proves nothing.
    assert.ok(!fs.existsSync(serverPath(NEWDIR)), 'the new directory should not be on the server yet');

    statuses = await engine.status(withPlugins);
    const created = statuses.filter((s) => s.localRelPath.startsWith(NEWDIR + '/'));
    assert.strictEqual(created.length, 2, `expected both new files, got ${JSON.stringify(created)}`);
    assert.ok(created.every((s) => s.state === 'created'), 'files in a new directory are creations');

    vscode.__answer.dialog = 'upload';
    push = await engine.push(withPlugins, created);
    assert.ok(
      push.outcomes.every((o) => o.outcome === 'pushed'),
      `pushing into a new directory should succeed: ${JSON.stringify(push.outcomes)}`
    );
    assert.ok(fs.existsSync(serverPath(NEWDIR + '/plugin.php')), 'the new file should exist on the server');
    assert.strictEqual(fs.readFileSync(serverPath(NEWDIR + '/plugin.php'), 'utf8').trim(), '<?php // brand new plugin');
    console.log('  created: new directory made on the server, both files pushed OK');

    // A second push of the same tree must be a no-op, not a re-upload.
    statuses = await engine.status(withPlugins);
    assert.ok(
      statuses.filter((s) => s.localRelPath.startsWith(NEWDIR + '/')).every((s) => s.state === 'inSync'),
      'the pushed files should now be in sync'
    );
    console.log('  created: new directory in sync after push OK');

    // ---------------------- 13. upload one named file, with no status scan
    // The right-click path. The user already knows which file they changed, so
    // nothing else is looked at — but the upload still travels through the
    // pipeline, so confirmation, backup and verification all still apply.
    vscode.__config['php.lintBeforePush'] = false; // this box need not have PHP
    const uploadOne = vscode.__registry.commands.get('remoteCodeCompanion.uploadToServer');
    assert.ok(uploadOne, 'the upload command should be registered');
    const fileUri = (rel) => vscode.Uri.file(localPath(rel));
    const dialogCount = () =>
      vscode.__registry.webviewPanels.filter((w) => w.viewType === 'remoteCodeCompanion.uploadConfirm').length;

    fs.writeFileSync(localPath(STYLE), 'body { color: rebeccapurple }' + String.fromCharCode(10));
    vscode.__answer.dialog = 'upload';
    let dialogs = dialogCount();
    await uploadOne(fileUri(STYLE));
    assert.strictEqual(
      fs.readFileSync(serverPath(STYLE), 'utf8'),
      'body { color: rebeccapurple }' + String.fromCharCode(10),
      'the named file should be on the server'
    );
    assert.strictEqual(dialogCount() - dialogs, 1, 'one file asks exactly once');
    statuses = await engine.status(config);
    assert.strictEqual(stateOf(statuses, STYLE), 'inSync', 'the baseline must advance after a verified upload');
    console.log('  upload file: uploaded, asked once, baseline advanced OK');

    // A dismissed dialog is a cancel: the server keeps what it had.
    fs.writeFileSync(localPath(STYLE), 'body { color: never-sent }' + String.fromCharCode(10));
    vscode.__answer.dialog = undefined; // the user closes the panel
    await uploadOne(fileUri(STYLE));
    assert.strictEqual(
      fs.readFileSync(serverPath(STYLE), 'utf8'),
      'body { color: rebeccapurple }' + String.fromCharCode(10),
      'a dismissed confirmation must not upload'
    );
    console.log('  upload file: dismissed dialog leaves the server untouched OK');

    // A conflict: push() refuses it, and this path does not pretend otherwise —
    // it uploads only because the user named the file and confirmed the warning.
    fs.writeFileSync(serverPath(STYLE), 'body { color: server-side }' + String.fromCharCode(10));
    manager.getConnection(PROFILE_ID).invalidateAll();
    fs.writeFileSync(localPath(STYLE), 'body { color: mine-wins }' + String.fromCharCode(10));
    statuses = await engine.status(config);
    assert.strictEqual(stateOf(statuses, STYLE), 'bothChanged', 'both sides changed');
    vscode.__answer.dialog = 'upload';
    await uploadOne(fileUri(STYLE));
    assert.strictEqual(
      fs.readFileSync(serverPath(STYLE), 'utf8'),
      'body { color: mine-wins }' + String.fromCharCode(10),
      'a confirmed forced upload must overwrite the server'
    );
    console.log('  upload file: conflicted file uploaded after an explicit confirmation OK');

    // ------------------------- 14. upload a folder: only what differs
    const FUNCTIONS = 'wp-content/themes/mytheme/functions.php';
    const APPJS = 'wp-content/themes/mytheme/assets/app.js';
    const NEWPHP = 'wp-content/themes/mytheme/new.php';
    fs.writeFileSync(localPath(FUNCTIONS), '<?php // v2' + String.fromCharCode(10));
    fs.writeFileSync(localPath(APPJS), 'console.log(2)' + String.fromCharCode(10));
    const backupsBefore = (await backups.listForFile(PROFILE_ID, '/' + STYLE)).length;

    vscode.__answer.dialog = 'upload';
    dialogs = dialogCount();
    await uploadOne(fileUri('wp-content/themes/mytheme'));

    // Two dialogs, and both are wanted: one for the batch as a whole, and one
    // for new.php, which the server no longer has — the pipeline stops for a
    // file with a real warning even inside a batch the user already approved.
    assert.strictEqual(dialogCount() - dialogs, 2, 'the batch asks once, plus once for the deleted-on-server file');
    assert.strictEqual(fs.readFileSync(serverPath(FUNCTIONS), 'utf8'), '<?php // v2' + String.fromCharCode(10));
    assert.strictEqual(fs.readFileSync(serverPath(APPJS), 'utf8'), 'console.log(2)' + String.fromCharCode(10));
    // Deleted on the server in step 10; a folder upload re-creates it.
    assert.ok(fs.existsSync(serverPath(NEWPHP)), 'the file missing from the server should be re-created');
    // style.css matched the server, so it must not have been sent again — a
    // re-upload would have left another pre-save backup behind.
    assert.strictEqual(
      (await backups.listForFile(PROFILE_ID, '/' + STYLE)).length,
      backupsBefore,
      'an unchanged file must not be re-uploaded by a folder upload'
    );
    statuses = await engine.status(config);
    assert.ok(
      [FUNCTIONS, APPJS, NEWPHP].every((rel) => stateOf(statuses, rel) === 'inSync'),
      'everything the folder upload sent should now be in sync'
    );
    console.log('  upload folder: changed files sent, unchanged skipped, deleted re-created OK');

    // Now that the subtree is clean, two ordinary edits prove the batch really
    // is one question rather than one per file.
    fs.writeFileSync(localPath(FUNCTIONS), '<?php // v3' + String.fromCharCode(10));
    fs.writeFileSync(localPath(APPJS), 'console.log(3)' + String.fromCharCode(10));
    vscode.__answer.dialog = 'upload';
    dialogs = dialogCount();
    await uploadOne(fileUri('wp-content/themes/mytheme'));
    assert.strictEqual(dialogCount() - dialogs, 1, 'two plain edits must be confirmed by a single dialog');
    assert.strictEqual(fs.readFileSync(serverPath(FUNCTIONS), 'utf8'), '<?php // v3' + String.fromCharCode(10));
    assert.strictEqual(fs.readFileSync(serverPath(APPJS), 'utf8'), 'console.log(3)' + String.fromCharCode(10));
    console.log('  upload folder: two changed files, one confirmation OK');


    // --------------------- 15. the native-modal fallback still works
    // confirm.style: modal is the escape hatch for anyone who would rather not
    // have a tab open for a confirmation. It must stay a working path, not a
    // setting that quietly does nothing.
    vscode.__config['confirm.style'] = 'modal';
    vscode.__answer.dialog = undefined; // no webview may be created on this path
    vscode.__answer.warning = 'Upload';
    fs.writeFileSync(localPath(STYLE), 'body { color: modal-path }' + String.fromCharCode(10));
    dialogs = dialogCount();
    await uploadOne(fileUri(STYLE));
    assert.strictEqual(dialogCount() - dialogs, 0, 'the modal path must not open a webview');
    assert.strictEqual(
      fs.readFileSync(serverPath(STYLE), 'utf8'),
      'body { color: modal-path }' + String.fromCharCode(10),
      'the native modal must still be able to confirm an upload'
    );
    const modalPrompt = vscode.__registry.messages.warn.slice(-1)[0] || '';
    assert.ok(/Upload "style.css"/.test(modalPrompt), 'the modal should name the file: ' + modalPrompt);
    vscode.__config['confirm.style'] = 'panel';
    vscode.__answer.warning = undefined;
    console.log('  confirm.style modal: native dialog confirmed the upload, no webview OK');

    console.log('\n  integration-sync-test OK\n');
  } finally {
    await manager.disconnectAll();
    await server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('\nintegration-sync-test FAILED');
    console.error(err);
    process.exit(1);
  }
);
