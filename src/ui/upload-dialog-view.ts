import { LineDelta } from './diff-summary';

/**
 * The markup of the upload confirmation, as a pure function of what is about to
 * happen. It lives apart from the webview plumbing so it can be unit-tested:
 * this dialog is the last thing between an editor buffer and a production
 * server, and a template that throws would block every save.
 *
 * Everything user-supplied is escaped here rather than at the call sites — a
 * file name is attacker-controlled often enough (a pulled plugin, a generated
 * file) that the escaping must not be optional.
 */

export type FactKind = 'ok' | 'warn' | 'info';

export interface DialogFact {
  kind: FactKind;
  text: string;
}

export interface DialogTarget {
  /** Where the remote copy lives; the authoritative identity of the upload. */
  remotePath: string;
  fileName: string;
  size: number;
  /** Undefined when the file does not exist on the server yet. */
  serverSize?: number;
  delta?: LineDelta;
  created: boolean;
  /** wp-config.php, .htaccess — a bad upload here takes the whole site down. */
  critical: boolean;
}

export interface UploadDialogModel {
  profileName: string;
  host: string;
  protocolLabel: string;
  /** "Push · 2 of 7", "Right-click upload" — why this dialog is on screen. */
  origin?: string;
  /** One file: the full detail view. Many: the list view. */
  targets: DialogTarget[];
  facts: DialogFact[];
  /** Offered only for a single file; a diff of a batch has no single subject. */
  canDiff: boolean;
  /**
   * Label for the "stop asking" checkbox. Absent when the dialog is up because
   * something is risky — silencing a warning must not be a side effect of it.
   */
  suppressLabel?: string;
  /** Shown under the buttons; the batch view uses it to say what happens next. */
  footnote?: string;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return bytes + ' B';
  }
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + ' KB';
  }
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** The extension, uppercased, as a small type badge. Empty for a file without one. */
function extensionBadge(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,6})$/.exec(fileName);
  return match ? match[1].toUpperCase() : '';
}

/** Split a remote path so the directory can be dimmed and the name emphasised. */
export function splitRemotePath(remotePath: string): { dir: string; name: string } {
  const cut = remotePath.lastIndexOf('/');
  if (cut < 0) {
    return { dir: '', name: remotePath };
  }
  return { dir: remotePath.slice(0, cut + 1), name: remotePath.slice(cut + 1) };
}

const FACT_GLYPH: Record<FactKind, string> = { ok: '✓', warn: '!', info: 'i' };

function factList(facts: DialogFact[]): string {
  if (facts.length === 0) {
    return '';
  }
  return [
    '<ul class="facts">',
    ...facts.map(
      (fact) =>
        '<li class="' +
        fact.kind +
        '"><span class="ico" aria-hidden="true">' +
        FACT_GLYPH[fact.kind] +
        '</span><span>' +
        escapeHtml(fact.text) +
        '</span></li>'
    ),
    '</ul>'
  ].join('');
}

function deltaHtml(target: DialogTarget): string {
  const parts: string[] = [];
  if (target.delta && (target.delta.added > 0 || target.delta.removed > 0)) {
    parts.push(
      '<span class="added">+' +
        target.delta.added +
        '</span> <span class="removed">−' +
        target.delta.removed +
        '</span> lines'
    );
  } else if (target.delta) {
    parts.push('identical to the server copy');
  }
  if (target.created) {
    parts.push('new file on the server');
  } else if (target.serverSize !== undefined) {
    parts.push('replaces ' + escapeHtml(formatBytes(target.serverSize)));
  }
  return parts.length ? '<p class="metrics">' + parts.join(' <span class="sep">·</span> ') + '</p>' : '';
}

function singleTarget(target: DialogTarget): string {
  const { dir, name } = splitRemotePath(target.remotePath);
  const badge = extensionBadge(target.fileName);
  return [
    '<section class="target' + (target.critical ? ' critical' : '') + '">',
    '<p class="head">',
    badge ? '<span class="badge">' + escapeHtml(badge) + '</span>' : '',
    '<span class="name">' + escapeHtml(target.fileName) + '</span>',
    '<span class="size">' + escapeHtml(formatBytes(target.size)) + '</span>',
    '</p>',
    '<p class="path"><span class="dir">' + escapeHtml(dir) + '</span>' + escapeHtml(name) + '</p>',
    deltaHtml(target),
    '</section>'
  ].join('');
}

function targetList(targets: DialogTarget[]): string {
  const bytes = targets.reduce((sum, t) => sum + t.size, 0);
  return [
    '<section class="target">',
    '<p class="head"><span class="name">' +
      targets.length +
      ' files</span><span class="size">' +
      escapeHtml(formatBytes(bytes)) +
      '</span></p>',
    '<ul class="filelist">',
    ...targets.map((target) => {
      const notes: string[] = [];
      if (target.created) {
        notes.push('new');
      }
      if (target.critical) {
        notes.push('critical');
      }
      if (target.delta && (target.delta.added > 0 || target.delta.removed > 0)) {
        notes.push('+' + target.delta.added + ' −' + target.delta.removed);
      }
      return [
        '<li' + (target.critical ? ' class="critical"' : '') + '>',
        '<span class="fname">' + escapeHtml(target.remotePath) + '</span>',
        '<span class="note">' + escapeHtml(notes.join(' · ')) + '</span>',
        '<span class="size">' + escapeHtml(formatBytes(target.size)) + '</span>',
        '</li>'
      ].join('');
    }),
    '</ul>',
    '</section>'
  ].join('');
}

const STYLE = [
  '*{box-sizing:border-box}',
  'body{margin:0;padding:5vh 1.25rem 2rem;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);',
  'color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;justify-content:center;align-items:flex-start}',
  '.card{width:100%;max-width:620px;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));',
  'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:8px;overflow:hidden;',
  'box-shadow:0 8px 30px rgba(0,0,0,.35)}',
  '.accent{height:3px;background:var(--vscode-button-background)}',
  '.card.risky .accent{background:var(--vscode-editorWarning-foreground,#cca700)}',
  '.body{padding:1.15rem 1.35rem 1.35rem}',
  'header{display:flex;gap:.85rem;align-items:flex-start;margin:0 0 1rem}',
  '.glyph{flex:0 0 34px;height:34px;border-radius:50%;background:var(--vscode-button-background);',
  'color:var(--vscode-button-foreground);display:flex;align-items:center;justify-content:center;font-size:17px;line-height:1}',
  '.card.risky .glyph{background:var(--vscode-editorWarning-foreground,#cca700);color:var(--vscode-editor-background)}',
  'h1{font-size:1.05rem;font-weight:600;margin:.15rem 0 .2rem}',
  'h1 em{font-style:normal;color:var(--vscode-textLink-foreground)}',
  '.sub{margin:0;font-size:.85em;color:var(--vscode-descriptionForeground)}',
  '.sep{opacity:.5;padding:0 .15rem}',
  '.target{border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:6px;',
  'padding:.7rem .8rem;background:var(--vscode-textCodeBlock-background)}',
  '.target.critical{border-color:var(--vscode-editorWarning-foreground,#cca700)}',
  '.target .head{display:flex;align-items:center;gap:.5rem;margin:0 0 .35rem}',
  '.badge{font-size:.65em;letter-spacing:.06em;padding:.15rem .35rem;border-radius:3px;',
  'background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}',
  '.name{font-weight:600;word-break:break-all}',
  '.size{margin-left:auto;font-size:.85em;color:var(--vscode-descriptionForeground);white-space:nowrap}',
  '.path{margin:0;font-family:var(--vscode-editor-font-family);font-size:.85em;line-height:1.45;overflow-wrap:anywhere}',
  '.path .dir{color:var(--vscode-descriptionForeground)}',
  '.metrics{margin:.45rem 0 0;font-size:.85em;color:var(--vscode-descriptionForeground)}',
  '.added{color:var(--vscode-gitDecoration-addedResourceForeground,#3fb950);font-weight:600}',
  '.removed{color:var(--vscode-gitDecoration-deletedResourceForeground,#f85149);font-weight:600}',
  '.filelist{list-style:none;margin:0;padding:0;max-height:220px;overflow:auto}',
  '.filelist li{display:flex;gap:.5rem;align-items:baseline;padding:.2rem 0;font-size:.85em}',
  '.filelist .fname{font-family:var(--vscode-editor-font-family);overflow-wrap:anywhere}',
  '.filelist .note{color:var(--vscode-descriptionForeground);white-space:nowrap;margin-left:auto}',
  '.filelist li.critical .fname{color:var(--vscode-editorWarning-foreground,#cca700)}',
  '.facts{list-style:none;margin:.9rem 0 0;padding:0;display:flex;flex-direction:column;gap:.4rem}',
  '.facts li{display:flex;gap:.55rem;align-items:flex-start;font-size:.88em;line-height:1.4}',
  '.facts .ico{flex:0 0 16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
  'font-size:11px;font-weight:700;margin-top:.1rem}',
  '.facts li.ok .ico{background:var(--vscode-gitDecoration-addedResourceForeground,#3fb950);color:var(--vscode-editor-background)}',
  '.facts li.warn .ico{background:var(--vscode-editorWarning-foreground,#cca700);color:var(--vscode-editor-background)}',
  '.facts li.info .ico{background:var(--vscode-descriptionForeground);color:var(--vscode-editor-background)}',
  '.facts li.info{color:var(--vscode-descriptionForeground)}',
  '.suppress{display:flex;gap:.5rem;align-items:center;margin:1rem 0 0;font-size:.88em;',
  'color:var(--vscode-descriptionForeground);cursor:pointer}',
  'footer{display:flex;gap:.5rem;align-items:center;margin:1.2rem 0 0}',
  'footer .grow{flex:1}',
  'button{font-family:inherit;font-size:inherit;padding:.45rem 1.1rem;border-radius:3px;cursor:pointer;',
  'border:1px solid transparent;background:var(--vscode-button-background);color:var(--vscode-button-foreground)}',
  'button:hover{background:var(--vscode-button-hoverBackground)}',
  'button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}',
  'button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}',
  'button.ghost{background:transparent;color:var(--vscode-foreground);border-color:var(--vscode-widget-border,var(--vscode-panel-border))}',
  'button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:1px}',
  'button[disabled]{opacity:.6;cursor:default}',
  '.kbd{margin:.7rem 0 0;font-size:.78em;color:var(--vscode-descriptionForeground);text-align:right}',
  '@media(max-width:520px){footer{flex-wrap:wrap}footer button{flex:1}}'
].join('');

const SCRIPT = [
  'var api = acquireVsCodeApi();',
  'var sent = false;',
  'function send(answer) {',
  '  if (sent) return;',
  '  sent = true;',
  '  var box = document.getElementById("suppress");',
  '  var buttons = document.querySelectorAll("button");',
  '  for (var i = 0; i < buttons.length; i++) buttons[i].disabled = true;',
  '  api.postMessage({ answer: answer, suppress: !!(box && box.checked) });',
  '}',
  'function bind(id, answer) {',
  '  var el = document.getElementById(id);',
  '  if (el) el.addEventListener("click", function () { send(answer); });',
  '}',
  'bind("upload", "upload");',
  'bind("diff", "diff");',
  'bind("cancel", "cancel");',
  // Enter confirms, unless a button already has focus and will fire its own click.
  'document.addEventListener("keydown", function (event) {',
  '  if (event.key === "Escape") { send("cancel"); return; }',
  '  if (event.key !== "Enter") return;',
  '  var active = document.activeElement;',
  '  if (active && active.tagName === "BUTTON") return;',
  '  send("upload");',
  '});',
  'var primary = document.getElementById("upload");',
  'if (primary) primary.focus();'
].join('\n');

/**
 * `nonce` gates the inline script, so the CSP can stay at `default-src 'none'`.
 * The caller generates a fresh one per render.
 */
export function renderUploadDialog(model: UploadDialogModel, nonce: string): string {
  const csp = ["default-src 'none'", "style-src 'unsafe-inline'", "script-src 'nonce-" + nonce + "'"].join('; ');
  const risky = model.facts.some((f) => f.kind === 'warn') || model.targets.some((t) => t.critical);
  const many = model.targets.length > 1;
  const subtitle = [model.host, model.protocolLabel, model.origin].filter(Boolean).map((part) => escapeHtml(String(part)));

  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<title>Confirm upload</title>',
    '<style>' + STYLE + '</style></head><body>',
    '<main class="card' + (risky ? ' risky' : '') + '" role="dialog" aria-modal="true" aria-labelledby="rcc-title">',
    '<div class="accent"></div><div class="body">',
    '<header>',
    '<span class="glyph" aria-hidden="true">&#8593;</span>',
    '<div>',
    '<h1 id="rcc-title">Upload to <em>' + escapeHtml(model.profileName) + '</em></h1>',
    '<p class="sub">' + subtitle.join('<span class="sep">·</span>') + '</p>',
    '</div>',
    '</header>',
    many ? targetList(model.targets) : singleTarget(model.targets[0]),
    factList(model.facts),
    model.suppressLabel
      ? '<label class="suppress"><input type="checkbox" id="suppress"><span>' +
        escapeHtml(model.suppressLabel) +
        '</span></label>'
      : '',
    '<footer>',
    '<button id="cancel" class="ghost">Cancel</button>',
    '<span class="grow"></span>',
    model.canDiff ? '<button id="diff" class="secondary">Diff with Server</button>' : '',
    '<button id="upload">' + (many ? 'Upload ' + model.targets.length + ' Files' : 'Upload') + '</button>',
    '</footer>',
    model.footnote ? '<p class="kbd">' + escapeHtml(model.footnote) + '</p>' : '',
    '<p class="kbd">Enter uploads <span class="sep">·</span> Esc cancels</p>',
    '</div></main>',
    '<script nonce="' + nonce + '">' + SCRIPT + '</script>',
    '</body></html>'
  ].join('');
}
