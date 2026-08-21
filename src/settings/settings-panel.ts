import * as fs from 'fs';
import * as vscode from 'vscode';
import { testProfileConnection } from '../connection/connection-manager';
import { RemoteCredentials } from '../connection/types';
import { CONFIG_ROOT } from '../constants';
import { formatError, Logger } from '../core/logger';
import { normalizeRemotePath } from '../core/remote-path';
import { configFromProfile, DEFAULT_EXCLUDES, parseConfig, serializeConfig } from '../profiles/config-file';
import { ProfileSecrets } from '../profiles/profile-secrets';
import { RemoteConfigStore } from '../profiles/remote-config-store';
import { remapRoots, suggestRemoteRoot } from '../core/connect-advice';
import { reportConnectionFailure } from '../profiles/tls-advice';
import { AuthMethod, defaultPort, Protocol, RemoteConfig } from '../profiles/types';

export interface SettingsPanelDeps {
  store: RemoteConfigStore;
  secrets: ProfileSecrets;
  logger: Logger;
  /** Called after anything changed, so a live connection can be dropped. */
  onConfigSaved(profileId: string): Promise<void>;
}

interface EditorSetting {
  key: string;
  label: string;
  type: 'boolean' | 'number' | 'enum';
  min?: number;
  options?: string[];
  hint?: string;
}

/**
 * Editor-wide settings surfaced in the panel. These live in VS Code settings
 * rather than in .rcc/config.json, because they describe how you want the
 * extension to behave, not which server this folder talks to.
 */
const EDITOR_SETTINGS: EditorSetting[] = [
  { key: 'confirmOnSave', label: 'Confirm before every upload', type: 'boolean' },
  {
    key: 'confirm.style',
    label: 'How that confirmation looks',
    type: 'enum',
    options: ['panel', 'modal'],
    hint: 'panel: a styled tab with the full remote path, the size and how many lines differ. modal: VS Code own dialog, which blocks the window but shows one line.'
  },
  { key: 'conflictCheck', label: 'Check for server-side changes before overwriting', type: 'boolean' },
  { key: 'backup.enabled', label: 'Back up the server file before overwriting it', type: 'boolean' },
  { key: 'backup.required', label: 'A failed backup blocks the save', type: 'boolean' },
  { key: 'wordpress.warnCriticalFiles', label: 'Always confirm wp-config.php and .htaccess', type: 'boolean' },
  { key: 'sync.warnOnFirstLocalSave', label: 'Explain the first local save', type: 'boolean' },
  { key: 'backup.maxPerFile', label: 'Backups kept per file', type: 'number', min: 1 },
  { key: 'backup.maxAgeDays', label: 'Days to keep backups', type: 'number', min: 1 },
  { key: 'maxFileSizeMB', label: 'Refuse to open remote files larger than (MB)', type: 'number', min: 1 },
  { key: 'connection.idleTimeoutSeconds', label: 'Close an idle connection after (seconds)', type: 'number', min: 30 },
  {
    key: 'sync.pullDelayMs',
    label: 'Pause between transfers in a pull (ms)',
    type: 'number',
    min: 0,
    hint: 'Raise this if a pull keeps failing. Every FTP transfer opens a new connection, and hosts block a rapid burst of them.'
  },
  {
    key: 'sync.verifyByHash',
    label: 'Verify server changes by hashing',
    type: 'enum',
    options: ['auto', 'always', 'never']
  }
];

interface PanelState {
  folderName: string;
  config: RemoteConfig;
  hasPassword: boolean;
  hasPassphrase: boolean;
  editor: Record<string, unknown>;
  otherRemotes: { id: string; name: string; folder: string }[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function rootHint(c: RemoteConfig): string | undefined {
  const suggested = suggestRemoteRoot(c);
  return suggested ? 'On this protocol the path is probably ' + suggested : undefined;
}

function tri(value: unknown): boolean | undefined {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return undefined;
}

function field(label: string, control: string, hint?: string): string {
  return [
    '<label class="field">',
    '<span class="label">' + escapeHtml(label) + '</span>',
    control,
    hint ? '<span class="hint">' + escapeHtml(hint) + '</span>' : '',
    '</label>'
  ].join('');
}

function checkbox(id: string, label: string, checked: boolean): string {
  return [
    '<label class="check span2">',
    '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '>',
    '<span>' + escapeHtml(label) + '</span>',
    '</label>'
  ].join('');
}

function triSelect(id: string, value: boolean | undefined): string {
  const option = (v: string, text: string, selected: boolean): string =>
    '<option value="' + v + '"' + (selected ? ' selected' : '') + '>' + text + '</option>';
  return [
    '<select id="' + id + '">',
    option('inherit', 'Use the editor-wide setting', value === undefined),
    option('true', 'Always', value === true),
    option('false', 'Never', value === false),
    '</select>'
  ].join('');
}

function editorField(setting: EditorSetting, value: unknown): string {
  const attr = ' data-editor="' + setting.key + '"';
  if (setting.type === 'boolean') {
    return [
      '<label class="check span2">',
      '<input type="checkbox"' + attr + (value === true ? ' checked' : '') + '>',
      '<span>' + escapeHtml(setting.label) + '</span>',
      '</label>'
    ].join('');
  }
  if (setting.type === 'enum') {
    const options = (setting.options ?? [])
      .map((o) => '<option value="' + o + '"' + (o === value ? ' selected' : '') + '>' + o + '</option>')
      .join('');
    return field(setting.label, '<select' + attr + '>' + options + '</select>');
  }
  const min = setting.min === undefined ? '' : ' min="' + setting.min + '"';
  return field(
    setting.label,
    '<input type="number"' + min + attr + ' value="' + Number(value ?? 0) + '">',
    setting.hint
  );
}

/**
 * One screen for everything configurable, instead of a chain of Quick Picks. The
 * wizard remains the right tool for first-time setup; this is for the far more
 * common "change one thing", and for seeing every value at once.
 */
export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  static async show(deps: SettingsPanelDeps, profileId?: string): Promise<void> {
    const remotes = deps.store.remotes();
    if (remotes.length === 0) {
      void vscode.window.showInformationMessage(
        'This folder has no remote yet. Run "Set Up Remote for This Folder" first.'
      );
      return;
    }
    const chosen = (profileId && remotes.find((r) => r.config.id === profileId)) || remotes[0];

    if (SettingsPanel.current) {
      SettingsPanel.current.profileId = chosen.config.id;
      SettingsPanel.current.panel.reveal();
      await SettingsPanel.current.refresh();
      return;
    }
    const panel = new SettingsPanel(deps, chosen.config.id);
    SettingsPanel.current = panel;
    await panel.refresh();
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly deps: SettingsPanelDeps,
    private profileId: string
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'remoteCodeCompanion.settings',
      'Remote Settings',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => {
      SettingsPanel.current = undefined;
      this.disposables.forEach((d) => d.dispose());
    });
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message) => void this.onMessage(message)),
      // A hand edit to config.json should be reflected here rather than silently
      // leaving the panel showing stale values the next Save would write back.
      deps.store.onDidChange(() => void this.refresh())
    );
  }

  private async state(): Promise<PanelState | undefined> {
    const config = this.deps.store.get(this.profileId);
    const folder = this.deps.store.folderFor(this.profileId);
    if (!config || !folder) {
      return undefined;
    }
    const cfg = vscode.workspace.getConfiguration(CONFIG_ROOT);
    const editor: Record<string, unknown> = {};
    for (const setting of EDITOR_SETTINGS) {
      editor[setting.key] = cfg.get(setting.key);
    }
    return {
      folderName: folder.name,
      config,
      hasPassword: (await this.deps.secrets.get(config.id, 'password')) !== undefined,
      hasPassphrase: (await this.deps.secrets.get(config.id, 'passphrase')) !== undefined,
      editor,
      otherRemotes: this.deps.store
        .remotes()
        .filter((r) => r.config.id !== config.id)
        .map((r) => ({ id: r.config.id, name: r.config.name, folder: r.folder.name }))
    };
  }

  private async refresh(): Promise<void> {
    const state = await this.state();
    if (!state) {
      this.panel.dispose();
      return;
    }
    this.panel.title = 'Remote Settings — ' + state.folderName;
    this.panel.webview.html = this.render(state);
  }

  // ------------------------------------------------------------------ messages

  private async onMessage(message: { type?: string; [key: string]: unknown }): Promise<void> {
    try {
      switch (message.type) {
        case 'save':
          await this.save(message.config as Record<string, unknown>, message.editor as Record<string, unknown>);
          break;
        case 'setPassword':
          await this.setSecret('password', String(message.value ?? ''));
          break;
        case 'setPassphrase':
          await this.setSecret('passphrase', String(message.value ?? ''));
          break;
        case 'test':
          await this.testConnection(message.config as Record<string, unknown>);
          break;
        case 'switch':
          this.profileId = String(message.value ?? this.profileId);
          await this.refresh();
          break;
        case 'command': {
          // The panel is the entry point now, so the command already knows which
          // remote it applies to and never has to ask.
          const name = String(message.command ?? '');
          const allowed = ['exportRemoteConfig', 'importRemoteConfig', 'resetPreview', 'disableRemote'];
          if (allowed.includes(name)) {
            await vscode.commands.executeCommand(`remoteCodeCompanion.${name}`, { profileId: this.profileId });
          }
          break;
        }
        case 'reload':
          await this.refresh();
          break;
      }
    } catch (err) {
      this.deps.logger.error('settings panel action failed', err);
      void vscode.window.showErrorMessage(formatError(err));
    }
  }

  private async setSecret(kind: 'password' | 'passphrase', value: string): Promise<void> {
    if (value) {
      await this.deps.secrets.set(this.profileId, kind, value);
      void vscode.window.showInformationMessage('Stored the ' + kind + ' in the OS keychain.');
    } else {
      await this.deps.secrets.delete(this.profileId, kind);
      void vscode.window.showInformationMessage('Removed the stored ' + kind + '.');
    }
    await this.deps.onConfigSaved(this.profileId);
    await this.refresh();
  }

  /**
   * Build a config from the form. It is round-tripped through the real parser, so
   * the panel can never write a file the extension would then refuse to load.
   */
  private candidate(form: Record<string, unknown>): RemoteConfig | string {
    const existing = this.deps.store.get(this.profileId);
    if (!existing) {
      return 'This remote is no longer available.';
    }
    const str = (key: string): string => String(form[key] ?? '').trim();
    const lines = (key: string): string[] =>
      String(form[key] ?? '')
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);

    const protocol = str('protocol') as Protocol;
    const portRaw = Number(form.port);
    const draft = configFromProfile(
      {
        ...existing,
        name: str('name') || existing.name,
        protocol,
        host: str('host'),
        port: Number.isFinite(portRaw) && portRaw > 0 ? Math.trunc(portRaw) : defaultPort(protocol),
        username: str('username'),
        auth: str('auth') as AuthMethod,
        privateKeyPath: str('privateKeyPath') || undefined,
        remoteRoot: normalizeRemotePath(str('remoteRoot') || '/'),
        readOnly: form.readOnly === true,
        confirmOnSave: tri(form.confirmOnSave),
        backupOnSave: tri(form.backupOnSave),
        ftpSecureRejectUnauthorized: tri(form.ftpSecureRejectUnauthorized),
        updatedAt: Date.now()
      },
      existing
    );
    const submittedRoots = lines('roots').map((r) => normalizeRemotePath(r));
    // Changing the remote root would otherwise leave every synced subtree
    // pointing at a path that no longer exists.
    draft.roots =
      draft.remoteRoot === existing.remoteRoot
        ? submittedRoots
        : remapRoots(submittedRoots, existing.remoteRoot, draft.remoteRoot);
    draft.excludes = lines('excludes');
    const maxKb = Number(form.maxFileSizeKB);
    draft.maxFileSizeKB = Number.isFinite(maxKb) && maxKb > 0 ? Math.trunc(maxKb) : existing.maxFileSizeKB;

    if (draft.auth === 'privateKey' && draft.privateKeyPath && !fs.existsSync(draft.privateKeyPath)) {
      return 'Private key not found: ' + draft.privateKeyPath;
    }

    const verdict = parseConfig(serializeConfig(draft));
    return verdict.ok ? verdict.config : verdict.error;
  }

  private async save(form: Record<string, unknown>, editor: Record<string, unknown>): Promise<void> {
    const result = this.candidate(form);
    if (typeof result === 'string') {
      void vscode.window.showErrorMessage('Not saved: ' + result);
      return;
    }
    const folder = this.deps.store.folderFor(this.profileId);
    if (!folder) {
      return;
    }

    const cfg = vscode.workspace.getConfiguration(CONFIG_ROOT);
    for (const setting of EDITOR_SETTINGS) {
      const value = editor[setting.key];
      if (value === undefined) {
        continue;
      }
      if (JSON.stringify(cfg.get(setting.key)) !== JSON.stringify(value)) {
        await cfg.update(setting.key, value, vscode.ConfigurationTarget.Global);
      }
    }

    await this.deps.store.write(folder, result);
    await this.deps.onConfigSaved(result.id);
    void vscode.window.showInformationMessage('Saved settings for "' + folder.name + '".');
    await this.refresh();
  }

  private async testConnection(form: Record<string, unknown>): Promise<void> {
    const result = this.candidate(form);
    if (typeof result === 'string') {
      void vscode.window.showErrorMessage('Cannot test: ' + result);
      return;
    }
    let creds: RemoteCredentials;
    if (result.auth === 'privateKey') {
      if (!result.privateKeyPath) {
        void vscode.window.showWarningMessage('Set the private key path first.');
        return;
      }
      const passphrase = await this.deps.secrets.get(result.id, 'passphrase');
      creds = { privateKey: fs.readFileSync(result.privateKeyPath), passphrase: passphrase ?? undefined };
    } else {
      const password = await this.deps.secrets.get(result.id, 'password');
      if (password === undefined) {
        void vscode.window.showWarningMessage('No password stored yet — set one in the panel first.');
        return;
      }
      creds = { password };
    }
    const verdict = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Testing ' + result.host + '...' },
      () => testProfileConnection(result, creds, this.deps.logger)
    );
    if (verdict.ok) {
      void vscode.window.showInformationMessage('Connected to ' + result.host + ' successfully.');
    } else {
      await reportConnectionFailure(result, String(verdict.error), {
        store: this.deps.store,
        logger: this.deps.logger,
        onConfigSaved: this.deps.onConfigSaved
      });
      await this.refresh();
    }
  }

  // -------------------------------------------------------------------- render

  private render(state: PanelState): string {
    const c = state.config;
    const n = makeNonce();
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'nonce-" + n + "'"
    ].join('; ');

    const protocolOptions = (['ftp', 'ftps', 'ftps-implicit', 'sftp'] as Protocol[])
      .map((p) => '<option value="' + p + '"' + (p === c.protocol ? ' selected' : '') + '>' + p + '</option>')
      .join('');
    const authOptions = (['password', 'privateKey'] as AuthMethod[])
      .map((a) => '<option value="' + a + '"' + (a === c.auth ? ' selected' : '') + '>' + a + '</option>')
      .join('');

    const switcher =
      state.otherRemotes.length === 0
        ? ''
        : [
            '<div class="row"><span class="label">Other remotes in this window:</span>',
            state.otherRemotes
              .map(
                (r) =>
                  '<button class="secondary switch" data-id="' +
                  r.id +
                  '">' +
                  escapeHtml(r.name + ' (' + r.folder + ')') +
                  '</button>'
              )
              .join(''),
            '</div>'
          ].join('');

    return [
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
      '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
      '<style>' + STYLE + '</style></head><body>',
      '<h1>' + escapeHtml(c.name) + '</h1>',
      '<p class="sub">Folder <code>' +
        escapeHtml(state.folderName) +
        '</code> · saved to <code>.rcc/config.json</code></p>',
      switcher,

      '<section><h2>Connection</h2><div class="grid">',
      field('Display name', '<input id="name" value="' + escapeHtml(c.name) + '">'),
      field('Protocol', '<select id="protocol">' + protocolOptions + '</select>'),
      field('Host', '<input id="host" value="' + escapeHtml(c.host) + '">'),
      field('Port', '<input id="port" type="number" min="1" max="65535" value="' + c.port + '">'),
      field(
        'Username',
        '<input id="username" value="' + escapeHtml(c.username) + '">',
        // The single most common failure when a profile is switched from FTP to
        // SFTP: cPanel FTP sub-accounts cannot log in over SSH at all.
        c.protocol === 'sftp' && c.username.includes('@')
          ? 'This looks like an FTP sub-account. SSH needs the main cPanel account: ' +
            c.username.slice(0, c.username.indexOf('@'))
          : undefined
      ),
      field('Authentication', '<select id="auth">' + authOptions + '</select>'),
      field(
        'Private key path',
        '<input id="privateKeyPath" value="' +
          escapeHtml(c.privateKeyPath ?? '') +
          '" placeholder="SFTP key auth only">'
      ),
      field(
        'Remote root',
        '<input id="remoteRoot" value="' + escapeHtml(c.remoteRoot) + '">',
        // Over SSH the same directory lives under the home folder, so a path
        // carried over from an FTP profile will not exist.
        rootHint(c)
      ),
      checkbox('readOnly', 'Read-only — block every write to this server', c.readOnly),
      '</div></section>',

      '<section><h2>Credentials</h2>',
      '<p class="sub">' +
        (state.hasPassword ? 'A password is stored in the OS keychain.' : 'No password stored yet.') +
        ' It is never written to <code>.rcc/config.json</code>.</p>',
      '<div class="row">',
      '<input id="password" type="password" placeholder="new password (leave empty to keep the current one)">',
      '<button class="secondary" id="savePassword">Update</button>',
      state.hasPassword ? '<button class="danger" id="clearPassword">Forget</button>' : '',
      '</div>',
      c.auth === 'privateKey'
        ? [
            '<p class="sub">' +
              (state.hasPassphrase ? 'A key passphrase is stored.' : 'No key passphrase stored.') +
              '</p>',
            '<div class="row">',
            '<input id="passphrase" type="password" placeholder="key passphrase">',
            '<button class="secondary" id="savePassphrase">Update</button>',
            '</div>'
          ].join('')
        : '',
      '</section>',

      '<section><h2>Sync</h2><div class="grid">',
      field(
        'Skip files larger than (KB)',
        '<input id="maxFileSizeKB" type="number" min="1" value="' + c.maxFileSizeKB + '">'
      ),
      '</div>',
      field(
        'Synced subtrees — one remote path per line',
        '<textarea id="roots" rows="4" spellcheck="false">' + escapeHtml(c.roots.join(NL)) + '</textarea>',
        'Pull adds a path here. Delete a line to stop tracking that subtree.'
      ),
      field(
        'Never pulled — one glob per line, relative to the remote root',
        '<textarea id="excludes" rows="10" spellcheck="false">' + escapeHtml(c.excludes.join(NL)) + '</textarea>',
        'The defaults skip WordPress core, uploads, caches and binary assets.'
      ),
      '<div class="row"><button class="secondary" id="resetExcludes">Restore default excludes</button></div>',
      '</section>',

      '<section><h2>Overrides for this remote</h2><div class="grid">',
      field('Confirm before upload', triSelect('confirmOnSave', c.confirmOnSave)),
      field('Back up before overwrite', triSelect('backupOnSave', c.backupOnSave)),
      field(
        'Reject untrusted FTPS certificate',
        triSelect('ftpSecureRejectUnauthorized', c.ftpSecureRejectUnauthorized)
      ),
      '</div></section>',

      '<section><h2>This folder</h2>',
      '<p class="sub">Actions that used to sit in the command palette.</p>',
      '<div class="row">',
      '<button class="secondary" id="exportConfig">Export config...</button>',
      '<button class="secondary" id="importConfig">Import config...</button>',
      '<button class="secondary" id="resetPreview">Reset preview site</button>',
      '<button class="danger" id="disableRemote">Disable remote</button>',
      '</div>',
      '<p class="hint">Export leaves the password out. Disabling deletes .rcc/config.json and the stored password; pulled files and backups stay.</p>',
      '</section>',

      '<section><h2>Editor-wide settings</h2>',
      '<p class="sub">These apply to every remote, in every window.</p><div class="grid">',
      EDITOR_SETTINGS.map((setting) => editorField(setting, state.editor[setting.key])).join(''),
      '</div></section>',

      '<div class="actions">',
      '<button id="save">Save</button>',
      '<button class="secondary" id="test">Test connection</button>',
      '<button class="secondary" id="reload">Discard changes</button>',
      '</div>',

      '<script nonce="' + n + '">',
      'const DEFAULT_EXCLUDES = ' + JSON.stringify(DEFAULT_EXCLUDES) + ';',
      SCRIPT,
      '</script></body></html>'
    ].join('');
  }
}

/** Newline as a value, so this module needs no escape sequences in HTML. */
const NL = `
`;

const STYLE = [
  'body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:1.5rem 2rem 0;max-width:920px;margin:0 auto;font-size:var(--vscode-font-size)}',
  'h1{font-size:1.4rem;margin:0 0 .25rem}',
  'h2{font-size:1rem;margin:0 0 .75rem;padding-bottom:.35rem;border-bottom:1px solid var(--vscode-panel-border)}',
  'section{margin:1.75rem 0}',
  '.sub{color:var(--vscode-descriptionForeground);margin:.25rem 0 1rem;font-size:.9em}',
  'code{background:var(--vscode-textCodeBlock-background);padding:.1rem .3rem;border-radius:3px}',
  '.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.9rem 1.25rem}',
  '.field{display:flex;flex-direction:column;gap:.3rem}',
  '.span2{grid-column:1/-1}',
  '.label{font-size:.85em;color:var(--vscode-descriptionForeground)}',
  '.hint{font-size:.8em;color:var(--vscode-descriptionForeground)}',
  'input,select,textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:.35rem .5rem;border-radius:2px;font-family:inherit;font-size:inherit;width:100%;box-sizing:border-box}',
  'textarea{font-family:var(--vscode-editor-font-family);resize:vertical}',
  'input:focus,select:focus,textarea:focus{outline:1px solid var(--vscode-focusBorder)}',
  '.check{display:flex;align-items:center;gap:.5rem;margin:.4rem 0}',
  '.check input{width:auto}',
  '.row{display:flex;gap:.5rem;align-items:center;margin:.5rem 0;flex-wrap:wrap}',
  '.row input{flex:1;min-width:12rem}',
  'button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:.45rem 1rem;border-radius:2px;cursor:pointer;font-family:inherit;font-size:inherit;white-space:nowrap}',
  'button:hover{background:var(--vscode-button-hoverBackground)}',
  'button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}',
  'button.danger{background:var(--vscode-inputValidation-errorBackground);color:var(--vscode-foreground)}',
  '.actions{display:flex;gap:.5rem;position:sticky;bottom:0;background:var(--vscode-editor-background);padding:1rem 0;border-top:1px solid var(--vscode-panel-border)}',
  '@media(max-width:640px){.grid{grid-template-columns:1fr}}'
].join('');

const SCRIPT = [
  'const vscode = acquireVsCodeApi();',
  'const CONFIG_IDS = ["name","protocol","host","port","username","auth","privateKeyPath","remoteRoot","readOnly","roots","excludes","maxFileSizeKB","confirmOnSave","backupOnSave","ftpSecureRejectUnauthorized"];',
  'function collect() {',
  '  const config = {};',
  '  for (const id of CONFIG_IDS) {',
  '    const el = document.getElementById(id);',
  '    if (!el) continue;',
  '    config[id] = el.type === "checkbox" ? el.checked : el.value;',
  '  }',
  '  const editor = {};',
  '  for (const el of document.querySelectorAll("[data-editor]")) {',
  '    const key = el.getAttribute("data-editor");',
  '    if (el.type === "checkbox") editor[key] = el.checked;',
  '    else if (el.type === "number") editor[key] = Number(el.value);',
  '    else editor[key] = el.value;',
  '  }',
  '  return { config: config, editor: editor };',
  '}',
  'function on(id, fn) { const el = document.getElementById(id); if (el) el.addEventListener("click", fn); }',
  'on("save", function () { const p = collect(); vscode.postMessage({ type: "save", config: p.config, editor: p.editor }); });',
  'on("test", function () { vscode.postMessage({ type: "test", config: collect().config }); });',
  'on("reload", function () { vscode.postMessage({ type: "reload" }); });',
  'on("savePassword", function () {',
  '  const el = document.getElementById("password");',
  '  if (el && el.value) { vscode.postMessage({ type: "setPassword", value: el.value }); el.value = ""; }',
  '});',
  'on("clearPassword", function () { vscode.postMessage({ type: "setPassword", value: "" }); });',
  'on("savePassphrase", function () {',
  '  const el = document.getElementById("passphrase");',
  '  if (el && el.value) { vscode.postMessage({ type: "setPassphrase", value: el.value }); el.value = ""; }',
  '});',
  'on("exportConfig", function () { vscode.postMessage({ type: "command", command: "exportRemoteConfig" }); });',
  'on("importConfig", function () { vscode.postMessage({ type: "command", command: "importRemoteConfig" }); });',
  'on("resetPreview", function () { vscode.postMessage({ type: "command", command: "resetPreview" }); });',
  'on("disableRemote", function () { vscode.postMessage({ type: "command", command: "disableRemote" }); });',
  'on("resetExcludes", function () {',
  '  document.getElementById("excludes").value = DEFAULT_EXCLUDES.join(String.fromCharCode(10));',
  '});',
  'for (const el of document.querySelectorAll(".switch")) {',
  '  el.addEventListener("click", function () { vscode.postMessage({ type: "switch", value: el.getAttribute("data-id") }); });',
  '}'
].join(NL);
