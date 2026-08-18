'use strict';
// Minimal vscode API mock for the smoke test. Only what activate() touches.

class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    if (this._fn) {
      this._fn();
    }
  }
  static from(...items) {
    return new Disposable(() => items.forEach((i) => i.dispose && i.dispose()));
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener) => {
      this._listeners.add(listener);
      return new Disposable(() => this._listeners.delete(listener));
    };
  }
  fire(e) {
    for (const listener of [...this._listeners]) {
      listener(e);
    }
  }
  dispose() {
    this._listeners.clear();
  }
}

class Uri {
  constructor(scheme, authority, path, query = '', fragment = '') {
    this.scheme = scheme;
    this.authority = (authority || '').toLowerCase(); // mimic real vscode.Uri
    this.path = path || '';
    this.query = query || '';
    this.fragment = fragment || '';
  }
  static from(o) {
    return new Uri(o.scheme, o.authority, o.path, o.query, o.fragment);
  }
  static file(p) {
    return new Uri('file', '', String(p).replace(/\\/g, '/'));
  }
  static parse(s) {
    const m = /^([a-zA-Z][\w+.-]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(s);
    if (m) {
      return new Uri(m[1], m[2], decodeURIComponent(m[3] || '/'), m[4] || '', m[5] || '');
    }
    const m2 = /^([a-zA-Z][\w+.-]*):(.*)$/.exec(s);
    return new Uri(m2 ? m2[1] : 'file', '', m2 ? m2[2] : s);
  }
  static joinPath(base, ...parts) {
    const joined = [base.path.replace(/\/+$/, ''), ...parts].join('/');
    return new Uri(base.scheme, base.authority, joined, base.query, base.fragment);
  }
  with(change) {
    return new Uri(
      change.scheme !== undefined ? change.scheme : this.scheme,
      change.authority !== undefined ? change.authority : this.authority,
      change.path !== undefined ? change.path : this.path,
      change.query !== undefined ? change.query : this.query,
      change.fragment !== undefined ? change.fragment : this.fragment
    );
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    const encodedPath = this.path
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    return `${this.scheme}://${this.authority}${encodedPath}${this.query ? '?' + this.query : ''}${
      this.fragment ? '#' + this.fragment : ''
    }`;
  }
  toJSON() {
    return { scheme: this.scheme, authority: this.authority, path: this.path };
  }
}

class FileSystemError extends Error {
  constructor(messageOrUri, code) {
    super(typeof messageOrUri === 'string' ? messageOrUri : String(messageOrUri));
    this.code = code;
  }
  static FileNotFound(m) {
    return new FileSystemError(m, 'FileNotFound');
  }
  static FileExists(m) {
    return new FileSystemError(m, 'FileExists');
  }
  static FileIsADirectory(m) {
    return new FileSystemError(m, 'FileIsADirectory');
  }
  static FileNotADirectory(m) {
    return new FileSystemError(m, 'FileNotADirectory');
  }
  static NoPermissions(m) {
    return new FileSystemError(m, 'NoPermissions');
  }
  static Unavailable(m) {
    return new FileSystemError(m, 'Unavailable');
  }
}

class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

function makeRegistry() {
  return {
    commands: new Map(),
    fsProviders: new Map(),
    contentProviders: new Map(),
    treeViews: new Map(),
    statusBarItems: [],
    watchers: [],
    // setContext calls, so the test can assert the view-gating key
    contextKeys: new Map(),
    executed: [],
    messages: { info: [], warn: [], error: [] },
    webviewPanels: []
  };
}

function createVscodeMock() {
  const registry = makeRegistry();
  /**
   * Canned answers for modal dialogs, so a test can play the user: set
   * `mock.__answer.warning = 'Upload'` to confirm, leave it undefined to cancel.
   * A function receives the dialog's arguments.
   */
  const respond = (kind, args) => {
    const reply = mock.__answer[kind];
    return typeof reply === 'function' ? reply(...args) : reply;
  };
  const mock = {
    __registry: registry,
    __answer: { info: undefined, warning: undefined, error: undefined, quickPick: undefined, inputBox: undefined },
    __config: {},
    version: '1.85.0',
    Disposable,
    EventEmitter,
    Uri,
    FileSystemError,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    FilePermission: { Readonly: 1 },
    FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
    ViewColumn: { Active: -1, One: 1, Two: 2 },
    window: {
      createOutputChannel: () => ({
        appendLine: () => undefined,
        append: () => undefined,
        clear: () => undefined,
        show: () => undefined,
        dispose: () => undefined
      }),
      createStatusBarItem: () => {
        const item = { text: '', tooltip: '', command: undefined, show: () => undefined, hide: () => undefined, dispose: () => undefined };
        registry.statusBarItems.push(item);
        return item;
      },
      createWebviewPanel: (viewType, title, _col, _opts) => {
        const panel = {
          viewType,
          title,
          visible: true,
          webview: {
            html: "",
            cspSource: "vscode-webview:",
            options: {},
            asWebviewUri: (u) => u,
            postMessage: async () => true,
            onDidReceiveMessage: new EventEmitter().event
          },
          onDidDispose: new EventEmitter().event,
          onDidChangeViewState: new EventEmitter().event,
          reveal: () => undefined,
          dispose: () => undefined
        };
        registry.webviewPanels.push(panel);
        return panel;
      },
      createTreeView: (id, options) => {
        registry.treeViews.set(id, options);
        return { dispose: () => undefined, onDidChangeVisibility: new EventEmitter().event };
      },
      registerTreeDataProvider: (id, provider) => {
        registry.treeViews.set(id, { treeDataProvider: provider });
        return new Disposable();
      },
      showInformationMessage: async (...args) => {
        registry.messages.info.push(String(args[0]));
        return respond('info', args);
      },
      showWarningMessage: async (...args) => {
        registry.messages.warn.push(String(args[0]));
        return respond('warning', args);
      },
      showErrorMessage: async (...args) => {
        registry.messages.error.push(String(args[0]));
        return respond('error', args);
      },
      showInputBox: async (...args) => respond('inputBox', args),
      showQuickPick: async (...args) => respond('quickPick', args),
      showSaveDialog: async () => undefined,
      showOpenDialog: async () => undefined,
      withProgress: (_opts, task) => task({ report: () => undefined }),
      onDidChangeActiveTextEditor: new EventEmitter().event,
      activeTextEditor: undefined
    },
    workspace: {
      registerFileSystemProvider: (scheme, provider) => {
        registry.fsProviders.set(scheme, provider);
        return new Disposable();
      },
      registerTextDocumentContentProvider: (scheme, provider) => {
        registry.contentProviders.set(scheme, provider);
        return new Disposable();
      },
      getConfiguration: () => ({
        // __config lets a test drive settings that would otherwise be defaults.
        get: (key, defaultValue) => (key in mock.__config ? mock.__config[key] : defaultValue),
        update: async () => undefined,
        inspect: () => undefined
      }),
      getWorkspaceFolder: (uri) =>
        (mock.workspace.workspaceFolders || []).find((f) => String(uri.fsPath).startsWith(String(f.uri.fsPath))),
      onDidChangeConfiguration: new EventEmitter().event,
      onDidChangeWorkspaceFolders: new EventEmitter().event,
      onDidSaveTextDocument: new EventEmitter().event,
      workspaceFolders: [],
      updateWorkspaceFolders: () => true,
      createFileSystemWatcher: (pattern) => {
        const watcher = {
          pattern,
          onDidCreate: new EventEmitter().event,
          onDidChange: new EventEmitter().event,
          onDidDelete: new EventEmitter().event,
          dispose: () => undefined
        };
        registry.watchers.push(watcher);
        return watcher;
      },
      // Routed to the registered provider, so a write to an rcc:// URI really
      // does travel through RemoteFsProvider and the save pipeline.
      fs: {
        readFile: async (uri) => {
          const provider = registry.fsProviders.get(uri.scheme);
          return provider ? provider.readFile(uri) : new Uint8Array();
        },
        writeFile: async (uri, content) => {
          const provider = registry.fsProviders.get(uri.scheme);
          return provider ? provider.writeFile(uri, content, { create: true, overwrite: true }) : undefined;
        },
        stat: async (uri) => {
          const provider = registry.fsProviders.get(uri.scheme);
          return provider ? provider.stat(uri) : { type: 1, ctime: 0, mtime: 0, size: 0 };
        },
        delete: async (uri, options) => {
          const provider = registry.fsProviders.get(uri.scheme);
          return provider ? provider.delete(uri, options || { recursive: false }) : undefined;
        },
        rename: async () => undefined,
        createDirectory: async () => undefined
      }
    },
    commands: {
      registerCommand: (id, handler) => {
        registry.commands.set(id, handler);
        return new Disposable(() => registry.commands.delete(id));
      },
      executeCommand: async (id, ...args) => {
        registry.executed.push({ id, args });
        if (id === 'setContext') {
          registry.contextKeys.set(args[0], args[1]);
        }
        return undefined;
      },
      getCommands: async () => [...registry.commands.keys()]
    },
    env: {
      clipboard: { writeText: async () => undefined },
      appName: 'VSCode-Mock'
    },
    extensions: { getExtension: () => undefined }
  };
  return mock;
}

function installVscodeMock() {
  const Module = require('module');
  const mock = createVscodeMock();
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return mock;
    }
    return originalLoad.apply(this, [request, parent, isMain]);
  };
  return mock;
}

module.exports = { installVscodeMock, createVscodeMock };
