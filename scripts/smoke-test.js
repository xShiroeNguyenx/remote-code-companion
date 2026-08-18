'use strict';
// Smoke test: activate the compiled extension against a mocked vscode API and
// assert the public surface (commands, providers, tree view) is registered and
// consistent with package.json.
//
// It also covers the M6 model: a remote belongs to a workspace folder via
// .rcc/config.json, folders without one contribute nothing, and a broken
// declaration is reported instead of silently ignored.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installVscodeMock } = require('./vscode-mock');

const VALID_CONFIG = {
  version: 1,
  id: 'ab12cd34',
  name: 'Prod',
  protocol: 'ftp',
  host: 'example.com',
  port: 21,
  username: 'user@example.com',
  auth: 'password',
  remoteRoot: '/public_html',
  readOnly: false,
  roots: [],
  excludes: [],
  maxFileSizeKB: 1024
};

function makeFolder(vscode, root, name, config) {
  fs.mkdirSync(root, { recursive: true });
  if (config) {
    fs.mkdirSync(path.join(root, '.rcc'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.rcc', 'config.json'),
      typeof config === 'string' ? config : JSON.stringify(config, null, 2),
      'utf8'
    );
  }
  return { uri: vscode.Uri.file(root), name, index: 0 };
}

async function main() {
  const vscode = installVscodeMock();

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcc-smoke-'));
  const storageDir = path.join(tmp, 'globalStorage');
  fs.mkdirSync(storageDir, { recursive: true });

  // Three folders: one valid remote, one plain project, one broken declaration.
  const withRemote = makeFolder(vscode, path.join(tmp, 'site'), 'site', VALID_CONFIG);
  const plain = makeFolder(vscode, path.join(tmp, 'unrelated'), 'unrelated', null);
  const broken = makeFolder(vscode, path.join(tmp, 'broken'), 'broken', '{ not json');
  vscode.workspace.workspaceFolders = [withRemote, plain, broken];

  const stateBackend = new Map();
  const secretsBackend = new Map();
  const context = {
    subscriptions: [],
    globalState: {
      get: (key, defaultValue) => (stateBackend.has(key) ? stateBackend.get(key) : defaultValue),
      update: async (key, value) => void stateBackend.set(key, value),
      keys: () => [...stateBackend.keys()],
      setKeysForSync: () => undefined
    },
    workspaceState: {
      get: () => undefined,
      update: async () => undefined,
      keys: () => []
    },
    secrets: {
      get: async (key) => secretsBackend.get(key),
      store: async (key, value) => void secretsBackend.set(key, value),
      delete: async (key) => void secretsBackend.delete(key),
      onDidChange: () => ({ dispose: () => undefined })
    },
    globalStorageUri: vscode.Uri.file(storageDir),
    extensionUri: vscode.Uri.file(process.cwd()),
    extensionPath: process.cwd(),
    asAbsolutePath: (p) => path.join(process.cwd(), p),
    extensionMode: 3
  };

  const extension = require(path.join(process.cwd(), 'out', 'extension.js'));
  assert.strictEqual(typeof extension.activate, 'function', 'activate export missing');
  assert.strictEqual(typeof extension.deactivate, 'function', 'deactivate export missing');

  await extension.activate(context);

  const registry = vscode.__registry;

  // FileSystemProvider + diff content provider registered under the right schemes.
  assert.ok(registry.fsProviders.has('rcc'), 'FileSystemProvider for scheme rcc not registered');
  assert.ok(registry.contentProviders.has('rcc-remote'), 'ContentProvider for scheme rcc-remote not registered');

  // Tree view created with the id declared in package.json.
  assert.ok(registry.treeViews.has('remoteCodeCompanion.explorer'), 'tree view not created');

  // Every command declared in package.json is actually registered, and vice versa.
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
  const declared = pkg.contributes.commands.map((c) => c.command);
  const registered = new Set(registry.commands.keys());
  const missing = declared.filter((id) => !registered.has(id));
  assert.deepStrictEqual(missing, [], `commands declared but not registered: ${missing.join(', ')}`);
  const undeclared = [...registered].filter((id) => !declared.includes(id));
  assert.deepStrictEqual(undeclared, [], `commands registered but not declared: ${undeclared.join(', ')}`);

  // The old global-profile surface must be gone.
  for (const gone of [
    'remoteCodeCompanion.addServer',
    'remoteCodeCompanion.removeServer',
    'remoteCodeCompanion.duplicateServer',
    'remoteCodeCompanion.mountWorkspaceFolder',
    'remoteCodeCompanion.exportProfiles'
  ]) {
    assert.ok(!registered.has(gone), `${gone} should no longer exist`);
  }

  // The view-gating context key reflects that one folder has a remote.
  assert.strictEqual(registry.contextKeys.get('rcc.hasRemote'), true, 'rcc.hasRemote should be true');

  // The config file is watched so hand edits are picked up.
  assert.ok(
    registry.watchers.some((w) => String(w.pattern).includes('.rcc/config.json')),
    'config.json must be watched'
  );

  // Tree roots: exactly the remote-enabled folder — not the plain or broken ones.
  const tree = registry.treeViews.get('remoteCodeCompanion.explorer').treeDataProvider;
  const roots = await tree.getChildren();
  assert.strictEqual(roots.length, 1, `expected 1 tree root, got ${roots.length}`);
  assert.strictEqual(roots[0].profileId, 'ab12cd34');
  assert.strictEqual(roots[0].path, '/public_html', 'root node should start at remoteRoot');
  const rootItem = tree.getTreeItem(roots[0]);
  assert.match(String(rootItem.description), /ftp:\/\/example\.com/);
  assert.match(String(rootItem.tooltip), /Folder: site/, 'tooltip should name the owning folder');

  // The unusable declaration is surfaced, naming the folder.
  assert.ok(
    registry.messages.warn.some((m) => m.includes('broken') && m.includes('.rcc/config.json')),
    `expected a warning about the broken config, got ${JSON.stringify(registry.messages.warn)}`
  );

  // The settings panel must render for a real config. This catches a broken
  // template before a user opens it, since the panel is pure string building.
  await registry.commands.get('remoteCodeCompanion.openSettings')();
  const panel = registry.webviewPanels[0];
  assert.ok(panel, 'openSettings should create a webview panel');
  assert.match(panel.title, /Remote Settings/);
  const html = panel.webview.html;
  assert.match(html, /Content-Security-Policy/, 'the panel must set a CSP');
  assert.match(html, /nonce-/, 'scripts must be nonce-gated');
  assert.match(html, /id="host"/, 'the host field should be rendered');
  assert.match(html, /example\.com/, 'the current host value should be filled in');
  assert.match(html, /id="excludes"/, 'the excludes editor should be rendered');
  assert.match(html, /id="roots"/, 'the synced-subtrees editor should be rendered');
  assert.match(html, /sync\.pullDelayMs/, 'editor-wide settings should be rendered');
  assert.ok(!/hunter2|password"\s*value=/.test(html), 'no stored secret may be rendered into the panel');

  // Actions removed from the command palette must be reachable here, otherwise
  // trimming the palette just hid them.
  for (const id of ['exportConfig', 'importConfig', 'resetPreview', 'disableRemote']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} button missing from the settings panel`);
  }

  // Edit Remote is gone; the Settings screen replaced it.
  assert.ok(!registered.has('remoteCodeCompanion.editRemote'), 'editRemote should no longer exist');

  // Commands hidden from the palette must still be registered — the panel and the
  // tree context menu invoke them.
  const hiddenInPalette = (pkg.contributes.menus.commandPalette || [])
    .filter((m) => m.when === 'false')
    .map((m) => m.command);
  for (const command of hiddenInPalette) {
    assert.ok(registered.has(command), `${command} is hidden from the palette but not registered`);
  }

  // A few key commands exist and are callable without a node.
  for (const id of ['remoteCodeCompanion.refresh', 'remoteCodeCompanion.showOutput']) {
    await registry.commands.get(id)();
  }

  // Secrets must never reach globalState, and the config on disk must stay clean.
  const stateJson = JSON.stringify([...stateBackend.entries()]);
  assert.ok(!stateJson.includes('password'), 'globalState must never contain passwords');
  // "auth": "password" is legitimate; a "password"/"passphrase" *field* is not.
  const onDisk = JSON.parse(fs.readFileSync(path.join(withRemote.uri.fsPath, '.rcc', 'config.json'), 'utf8'));
  assert.ok(!('password' in onDisk), '.rcc/config.json must never contain a password field');
  assert.ok(!('passphrase' in onDisk), '.rcc/config.json must never contain a passphrase field');

  await extension.deactivate();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`smoke-test OK — ${registry.commands.size} commands, 1 remote-enabled folder of 3`);
}

main().catch((err) => {
  console.error('smoke-test FAILED');
  console.error(err);
  process.exit(1);
});
