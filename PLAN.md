# Remote Code Companion — Implementation Plan

> **Status (2026-07-04): IMPLEMENTED — M1 through M4 complete.**
> - All source under `src/` per the structure below; compiles clean (`tsc`, strict), lint clean.
> - Tests green: 29/29 unit tests (`node:test`), smoke test (22 commands registered, providers + tree verified against package.json), and the integration test driving the real connection layer against in-process FTP (`ftp-srv`) and SFTP (`ssh2` server) — including MDTM refinement, cache invalidation, unicode names, queue serialization, and credential failure paths.
> - Packaged: `remote-code-companion-0.1.0.vsix` (~800 KB, platform-neutral — no native binaries included).
> - Remaining from this plan: M2/M3/M4 "done" criteria that require a real shared host + Extension Development Host (manual verification), and the M5 backlog.
>
> **Update (2026-08-14):** M1–M4 verified by hand against a real host over FTP (WordPress production tree browses correctly).
> **Phase 2 is specified in §14 — Workspace-Scoped Remotes, Local Source, MCP Bridge.** M6 shipped in 0.2.0, M7 in 0.3.0; M8 (the MCP bridge) is next. It changes the product model: a remote belongs to a workspace folder rather than to the editor, pulled source lands in that folder, and an AI assistant edits it through a guarded bridge. **§14.1 supersedes §2.2, and §14.2 supersedes the "Profile storage" row of §3** — §§2–13 below describe Phase 1 as built. `scripts/pull-remote.js` is a throwaway prototype of the pull half; M7 deletes it.

A VS Code extension that connects directly to production servers (primarily WordPress sites on shared hosting) over **FTP / FTPS / SFTP**, letting you browse the remote file tree, open files, edit, and save straight back to the server — no local checkout needed — with production-safety guardrails built in.

## 1. Problem & Goal

WordPress sites on cheap shared hosting (cPanel / DirectAdmin) usually have no local copy of the source. Editing through the host's web File Manager is painful: no syntax highlighting, no diff, no undo, one file at a time. Existing extensions either sync a local project folder (SFTP-style) or mount over SSH only (SSH FS) — neither fits the "no local project, FTP-only shared host, this is production" workflow.

**Goal:** open VS Code → pick a server → browse → click a file → edit → `Ctrl+S` uploads it back, with backup / conflict-detection / confirmation protecting the production site.

## 2. Confirmed Product Decisions

> Phase 1 as built. Point 2 is superseded by §14.1: a remote is now declared per workspace folder, and a global server list no longer exists.

1. **Protocols (v1):** FTP, FTPS (explicit + implicit), SFTP.
2. **UX — both modes:**
   - Default: a dedicated **Remote Explorer tree** in the sidebar (lazy-loads directories on expand, opens files on demand). VS Code never scans/indexes the whole remote tree.
   - Optional: **"Mount as Workspace Folder"** command via a `FileSystemProvider`, for users who want search / quick-open (with a warning that search traverses the server).
3. **Production safety (all in v1):** auto-backup before save, diff-with-server, confirm-on-save, plus per-profile **read-only** mode (nearly free to add).
4. **Distribution:** internal `.vsix` first; marketplace later.

## 3. Key Architectural Decisions

| Decision | Pick | Rationale |
|---|---|---|
| Tree + Mount share logic? | **One `RemoteFsProvider` on scheme `rcc:`; the tree opens files via `rcc:` URIs** | Save/backup/conflict logic lives in exactly one place (`writeFile`); `Ctrl+S` behaves identically in both modes |
| Profile storage (non-secret) | ~~`context.globalState` (typed JSON) + Export/Import commands~~ → **superseded by §14.2: `.rcc/config.json` in the workspace folder** | Global storage made every server visible from every window, and gave local source no owner |
| Secrets | `vscode.SecretStorage`, keys `remoteCodeCompanion.secret.<profileId>.<kind>` | Never in settings.json or globalState |
| Add/edit profile UI | Multi-step QuickPick/InputBox wizard (webview form = backlog) | ~200 lines vs a heavy webview; Remote-SSH / SSH FS prove QuickPick is enough |
| FTP/FTPS library | `basic-ftp` ^5 | Pure JS, zero deps, maintained; explicit + implicit FTPS, MDTM/MLSD support |
| SFTP library | `ssh2-sftp-client` ^10 (wraps `ssh2`) | Thin promise API; ssh2's native pieces are optional with pure-JS fallback → platform-neutral vsix |
| Activation | `activationEvents: ["onFileSystem:rcc"]` | VS Code ≥1.85 auto-activates on contributed views/commands; much lazier than `onStartupFinished` |
| URI design | `rcc://<profileId>/<absolute-remote-path>`; `remoteRoot` is only the starting point | Backups/diffs/bookmarks survive a later root change. **Profile ids must be lowercase hex** — `vscode.Uri` lowercases the authority |
| Bundler | None — plain `tsc` → `out/`, ship deps via `files` allowlist | Matches existing convention; both runtime deps are CommonJS pure-JS |
| Testing | Smoke test (mocked `vscode`) + `node:test` unit tests for pure modules + opt-in integration script running `ftp-srv` and an in-process `ssh2` SFTP server | Real protocol coverage without Docker |

## 4. Project Structure

```
remote-code-companion/
├── package.json
├── tsconfig.json                  # commonjs, ES2020, strict, out/ (same as anime-companion)
├── .eslintrc.cjs
├── README.md / CHANGELOG.md / LICENSE
├── media/icon.svg
├── scripts/
│   ├── smoke-test.js              # mock vscode, activate(), assert commands registered
│   ├── unit-test.js               # node --test out/**/*.test.js
│   └── integration-test.js        # ftp-srv + in-process ssh2 SFTP server on a temp dir
└── src/
    ├── extension.ts               # activate(): ctor-DI of ExtensionContext, register scheme/view/commands
    ├── log.ts                     # OutputChannel singleton
    ├── constants.ts               # SCHEME='rcc', DIFF_SCHEME='rcc-remote', state keys, config root
    ├── core/
    │   ├── async-queue.ts         # serialized promise queue (concurrency=1) — mandatory: basic-ftp is single-command
    │   ├── remote-path.ts         # POSIX-only path utils (never Windows path.join on remote paths)
    │   ├── rcc-uri.ts             # codec {profileId, remotePath} <-> vscode.Uri
    │   ├── errors.ts              # RccError hierarchy → vscode.FileSystemError + friendly messages
    │   └── *.test.ts              # colocated unit tests
    ├── connection/
    │   ├── types.ts               # RemoteClient, RemoteFileEntry, ClientCapabilities
    │   ├── ftp-remote-client.ts   # basic-ftp; FTP/FTPS; NOOP keep-alive; MDTM probe
    │   ├── sftp-remote-client.ts  # ssh2-sftp-client; password or private key + passphrase
    │   └── connection-manager.ts  # 1 pooled conn/profile, op queue, reconnect+backoff, idle-close, listing cache (TTL 10s)
    ├── profiles/
    │   ├── types.ts               # ServerProfile, PROFILE_STATE_KEY
    │   ├── profile-store.ts       # globalState-backed
    │   ├── profile-secrets.ts     # SecretStorage wrapper
    │   ├── profile-wizard.ts      # multi-step add/edit wizard + Test Connection step
    │   └── profile-commands.ts
    ├── fs/
    │   ├── remote-fs-provider.ts  # vscode.FileSystemProvider — the heart of the extension
    │   ├── file-state-tracker.ts  # baseline {mtimeMs, size, source} captured at open → conflict detection
    │   └── remote-content-provider.ts # readonly provider on 'rcc-remote' for diff
    ├── save/
    │   ├── conflict-detector.ts   # baseline vs fresh stat, granularity-aware by mtimeSource
    │   └── save-pipeline.ts       # backup → conflict → confirm → upload → verify
    ├── backup/
    │   ├── backup-manager.ts      # layout under globalStorageUri, retention pruning, restore
    │   └── backup-commands.ts     # Browse Backups (QuickPick), Restore
    ├── tree/
    │   ├── remote-tree-provider.ts# lazy TreeDataProvider, exclude globs
    │   └── tree-commands.ts       # open/refresh/new/rename/delete/download/upload/copy path/mount
    ├── ui/status-bar.ts           # connection state, transfer spinner, "Uploaded ✓"
    └── wordpress/wp-heuristics.ts # root guesses ['public_html','www','htdocs'], CRITICAL_FILES ['wp-config.php','.htaccess']
```

## 5. Key Interfaces

```ts
// profiles/types.ts
type Protocol = 'ftp' | 'ftps' | 'ftps-implicit' | 'sftp';

interface ServerProfile {
  id: string;                  // 8-char LOWERCASE hex (vscode.Uri lowercases the authority)
  name: string;
  protocol: Protocol;
  host: string;
  port: number;                // defaults: ftp/ftps 21, ftps-implicit 990, sftp 22
  username: string;
  auth: 'password' | 'privateKey';   // privateKey: sftp only
  privateKeyPath?: string;     // local path; passphrase lives in SecretStorage
  remoteRoot: string;          // absolute POSIX path; wizard suggests public_html
  readOnly: boolean;           // browse/diff only
  confirmOnSave?: boolean;     // per-profile override (undefined = inherit global)
  backupOnSave?: boolean;      // per-profile override
  ftpSecureRejectUnauthorized?: boolean; // default true; escape hatch for self-signed shared-host certs
  createdAt: number;
  updatedAt: number;
}

// connection/types.ts
interface RemoteFileEntry {
  name: string;
  path: string;                       // absolute remote path
  type: 'file' | 'directory' | 'symlink';
  size: number;
  mtimeMs?: number;
  mtimeSource: 'mdtm' | 'listing' | 'sftp' | 'none'; // drives conflict-check confidence
}

interface ClientCapabilities {
  preciseMtime: boolean;              // sftp true; ftp true only after MDTM probe succeeds
  rename: boolean;
}

interface RemoteClient {
  readonly profileId: string;
  readonly capabilities: ClientCapabilities;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  list(dirPath: string): Promise<RemoteFileEntry[]>;
  stat(remotePath: string): Promise<RemoteFileEntry>; // FTP: derived from parent list() + MDTM refinement
  readFile(remotePath: string): Promise<Buffer>;
  writeFile(remotePath: string, data: Buffer): Promise<void>;
  delete(remotePath: string, type: 'file' | 'directory'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(remotePath: string): Promise<void>;
}
// Every public method is dispatched through the connection's AsyncQueue —
// basic-ftp throws on overlapping commands, and shared hosts cap connections at 1–4 per IP.

// backup/types.ts
interface BackupEntry {
  id: string;                 // `${timestamp}-${rand4}`
  profileId: string;
  remotePath: string;
  fileName: string;           // `${timestamp}__${basename}` on disk
  timestamp: number;
  size: number;
  reason: 'pre-save' | 'pre-delete' | 'manual';
}
```

## 6. Save Pipeline (the core algorithm, inside `RemoteFsProvider.writeFile`)

1. **Resolve** profile + effective options (per-profile override ?? global setting).
2. **Read-only gate** → throw `FileSystemError.NoPermissions('Profile is read-only')`.
3. Wrap everything in `vscode.window.withProgress` + a **per-URI mutex** (a second `Ctrl+S` queues behind the first).
4. **Fresh stat** from the server (one network op, reused by steps 5–6). File missing remotely → it's a create: skip 5–6.
5. **Conflict check** (if enabled and a baseline exists):
   - `sftp` / `mdtm` source → conflict if mtime OR size differs.
   - `listing` source → minute granularity: conflict if size differs OR `|mtimeDelta| > 120s`.
   - `none` → size-only; log "conflict check degraded" once per profile.
   - On conflict → modal: **Overwrite / Diff with Server / Cancel**. Diff opens `vscode.diff` and cancels the save.
6. **Backup** (if enabled and file exists): download current server bytes → `BackupManager.write(..., 'pre-save')` → prune. Backup failure is a **hard stop** by default (`backup.required`); modal "Backup failed — save anyway?".
7. **Confirm** (if enabled): modal `Upload <basename> to <profile.name> (<host>)?` — **always shown** for WordPress critical files (`wp-config.php`, `.htaccess`) regardless of the toggle.
8. **Upload** via the queued client.
9. **Verify**: re-stat; assert size matches; on mismatch report "upload may be incomplete — server reports N bytes" with a reference to the backup.
10. **Refresh baseline** in `FileStateTracker`, invalidate parent listing cache, fire `onDidChangeFile`, status bar flashes "Uploaded ✓".

A user cancel at any step throws a `FileSystemError` → the editor stays dirty (nothing is lost) with an explicit "Save cancelled" message.

## 7. Connection Layer Essentials

- **1 connection per profile** (a `maxConnections` setting is reserved for later), every op through the AsyncQueue.
- **Keep-alive:** FTP → `NOOP` every 30s while idle; SFTP → ssh2 `keepaliveInterval: 15000, keepaliveCountMax: 3`.
- **Idle close** after `connection.idleTimeoutSeconds` (default 300) — shared hosts kill idle sessions anyway; we close cleanly first.
- **Reconnect:** on a connection-class failure, reconnect once (1s backoff) and replay the single failed op; if that fails, surface the error and set the status bar to "disconnected".
- **Listing cache** per profile (`Map<dirPath, {entries, at}>`, TTL 10s), invalidated by any mutation under that dir — on FTP, `stat()` = LIST of the parent, and VS Code calls stat constantly.
- **Consistent mtime source per connection** (once MDTM capability is confirmed, always use MDTM for files) — mixing MDTM and LIST times causes spurious VS Code "content is newer" dialogs.
- Secrets are fetched from `ProfileSecrets` at connect time only.

## 8. Backup Layout (under `context.globalStorageUri`)

```
backups/<profileId>/
├── index.json                          # BackupIndex: hash → full remote path + entries
└── files/<sha1(remotePath).slice(0,12)>/
    └── 2026-07-03T14-05-22-311Z__wp-config.php
```

- Hashed dir per remote file avoids Windows MAX_PATH and special-char issues.
- Retention: `backup.maxPerFile` (default 10) and `backup.maxAgeDays` (default 30); pruning runs after each write, scoped to that file's folder.
- **Restore uploads the backup bytes through the same SavePipeline** — which itself backs up the current server state first, so a restore is always undoable.
- Commands: **Browse Backups** (QuickPick: profile → file → entry → Open / Diff vs current server / Restore / Delete) and **Restore Latest Backup**.

## 9. Diff Command

`remoteCodeCompanion.diffWithServer` (editor title + palette, `when: resourceScheme == rcc`): `RemoteContentProvider` on scheme `rcc-remote` fetches fresh server bytes (bypassing all caches; URIs carry a nonce query so repeated diffs re-fetch), then `vscode.diff(serverSnapshotUri, editorUri, 'Server ↔ Your copy')`.

## 10. Tree View

- Roots = one collapsed node per profile (contextValue `rcc.profile`, icon reflects connection state). Expanding connects lazily and lists `remoteRoot`. Directories load children on expand only — nothing is prefetched.
- Exclude globs (`remoteCodeCompanion.tree.excludes`, default `wp-content/cache`, `node_modules`, `.git`) filter tree listings only; the FS provider stays truthful.
- File nodes set `resourceUri` (icons come free from the user's icon theme) and `command: vscode.open` with their `rcc:` URI.
- Context menu (contextValue-gated): Open, Diff with Server, Download…, Upload File Here…, New File, New Folder, Rename, Delete (modal confirm + pre-delete backup), Copy Remote Path, Refresh; profile nodes add Connect/Disconnect, Edit, Mount as Workspace Folder, Remove.
- **Mount** = `vscode.workspace.updateWorkspaceFolders(...)` with the `rcc:` root URI, after a one-time warning that search/quick-open will traverse the server on demand.

## 11. package.json Sketch

- `engines.vscode: ^1.85.0`, `main: ./out/extension.js`, `activationEvents: ["onFileSystem:rcc"]`.
- `contributes`: activitybar view container `remoteCodeCompanion` + tree view `Servers` + `viewsWelcome` with an "Add Server" button; commands (category "Remote Code Companion"): addServer, editServer, removeServer, duplicateServer, connect, disconnect, refresh, openFile, diffWithServer, downloadFile, uploadFileHere, newFile, newFolder, rename, delete, copyRemotePath, mountWorkspaceFolder, browseBackups, restoreLatestBackup, exportProfiles, importProfiles, showOutput.
- Settings (root `remoteCodeCompanion.`): `confirmOnSave` (true), `conflictCheck` (true), `backup.enabled` (true), `backup.required` (true), `backup.maxPerFile` (10), `backup.maxAgeDays` (30), `connection.idleTimeoutSeconds` (300), `maxFileSizeMB` (10 — larger files must use Download), `tree.excludes`, `wordpress.warnCriticalFiles` (true).
- Dependencies: `basic-ftp ^5`, `ssh2-sftp-client ^10`. DevDependencies: `typescript ^5.3`, `@types/vscode ^1.85`, `@types/node ^20`, `@types/ssh2-sftp-client`, `eslint ^8` + `@typescript-eslint ^7`, `@vscode/vsce`, `ftp-srv` (tests only).
- Packaging via `files` allowlist: `out/**`, `media/**`, plus `node_modules/{basic-ftp,ssh2-sftp-client,ssh2,asn1,bcrypt-pbkdf,tweetnacl,safer-buffer}/**`. **Never** include `cpu-features` or any `*.node` binary — keeps the vsix platform-neutral (ssh2 has a pure-JS fallback).
- Scripts: `compile` (tsc), `watch`, `lint`, `test` (compile + smoke + unit), `test:integration`, `package` (vsce).

## 12. Milestones

### M1 — Skeleton, connection layer, profiles
Files: package.json, tsconfig.json, .eslintrc.cjs, `src/extension.ts`, `log.ts`, `constants.ts`, `core/*` (+tests), `connection/*`, `profiles/*`, `scripts/*`.
**Done when:** extension activates in the Extension Development Host; Add/Edit/Remove Server wizard works with secrets verified absent from settings/globalState; "Test Connection" succeeds; integration script passes list/read/write/rename/delete against `ftp-srv` and the in-process SFTP server; unit tests green; `vsce package` produces a clean vsix (checked with `vsce ls`).

### M2 — Tree + open/save via the shared FileSystemProvider
Files: `fs/remote-fs-provider.ts`, `fs/file-state-tracker.ts`, `tree/*`, `ui/status-bar.ts`.
**Done when:** the tree lazily browses a real shared host; clicking a file opens it via `rcc:`; `Ctrl+S` uploads (plain pipeline: upload + verify only); status bar shows state; errors land in the OutputChannel with readable messages.

### M3 — Production-safety pipeline
Files: `save/*`, `backup/*`, `fs/remote-content-provider.ts`.
**Done when:** save = backup → conflict → confirm → upload → verify; editing the file on the server outside VS Code then saving triggers the conflict modal; Diff with Server works from the editor title; Browse Backups can open/diff/restore; retention pruning observed; per-profile readOnly blocks writes; `wp-config.php` always confirms.

### M4 — Mount-as-workspace, full file ops, WordPress polish, packaging
Files: `tree/tree-commands.ts` completions, mount command, `wordpress/wp-heuristics.ts`, README.
**Done when:** mount shows the server as a workspace folder with working search/quick-open/save; all context-menu ops work on both FTP and SFTP; excludes honored; wizard suggests `public_html`; internal `.vsix` installed and used for a real WordPress edit session end-to-end.

### M5 — Backlog (post-v1)
Marketplace listing, webview profile form, chmod display/edit, connection pool >1, temp-file streaming for large files, per-profile filename encoding, sync-directory download.

## 13. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Shared host drops idle/parallel connections | 1 pooled connection + op queue, keep-alive, idle-close, single transparent reconnect-retry |
| FTP mtime unreliability breaks conflict detection | `mtimeSource`-aware granularity, size as the primary signal, degrade loudly not silently |
| Backup fails then upload destroys the prod file | backup precedes upload and is a hard stop by default (`backup.required`) |
| vsix misses a new transitive dep of ssh2 | `vsce ls` review in M1/M4 done-criteria + integration test requiring libs from the packed layout |
| Native optional deps make the vsix platform-specific | never allowlist `cpu-features`/`*.node`; ssh2 pure-JS fallback |
| `vscode.Uri` lowercases the authority → profile lookup breaks | ids generated as lowercase hex; URI codec unit tests (spaces, `#`, `?`, `%`, Vietnamese/Japanese filenames) |
| Mounted folder triggers full server traversal via search | explicit warning modal on mount; tree mode remains the default UX |
| User cancels save and thinks it saved | thrown FileSystemError keeps the editor dirty; explicit "Save cancelled" message; status bar shows last-upload time only on success |

---

# 14. Phase 2 — Workspace-Scoped Remotes, Local Source, MCP Bridge

## 14.1 The model change

**This supersedes §2.2 and the "Profile storage" row of §3.** Phase 1 keeps server profiles in `context.globalState`, so every VS Code window shows every server. Two problems surfaced in use:

1. Most projects have nothing to do with a remote host, yet the Remote Explorer is present in all of them.
2. A server reachable from many windows has no owner. Once local source enters the picture, "which copy is current?" has no answer — two windows can hold two baselines and push over each other.

**New model — one workspace folder = one remote site:**

- A folder declares its remote in `.rcc/config.json`. No global server list exists.
- The extension activates only where that file is present; with no remote declared there is no view, no icon, nothing running.
- Pulled source lands **directly in the workspace folder**, not in a separate mirror directory — so git, IntelliSense, search and any AI assistant treat it as ordinary local code.
- Baseline, backups and audit log live in `.rcc/` beside the source.

Setting up a site therefore reads: create a folder → open it → **Set Up Remote for This Folder** → pull.

## 14.2 Architectural Decisions

| Decision | Pick | Rationale |
|---|---|---|
| Config scope | Per **workspace folder**, not per window | Multi-root still works: each folder owns its own remote independently, and a folder without `.rcc/config.json` is simply not remote-enabled |
| Config storage | `.rcc/config.json` — plain JSON, no secrets | Visible, hand-editable, portable to another machine, and committable for a team. `workspaceState` would hide it and lose it on copy |
| Secrets | Unchanged: `SecretStorage`, keyed `remoteCodeCompanion.secret.<profileId>.<kind>` | The config file must stay safe to commit; the password never enters it |
| Source location | Workspace folder root, mapped from `remoteRoot` (`/public_html/wp-content/themes/x` → `<folder>/wp-content/themes/x`) | Paths mirror the server, so a push target is never ambiguous. No `files/` wrapper — the assistant and the tooling see a normal project |
| `Ctrl+S` on a local file | Writes to disk only; the server is touched by **Push Changes** | Editing a file and hitting save is not consent to deploy. Batch pushes also mean one confirmation for a coherent change, not one per file |
| `Ctrl+S` on an `rcc://` file | Unchanged — full pipeline, uploads immediately | The tree stays the fast path for one-off fixes to files that were never pulled |
| Servers per folder | Exactly one | Removes the "pulled from production, pushed to staging" class of accident. Multiple deploy targets is backlog |
| Mount as Workspace Folder | **Removed** (was §2.2 / §10) | Once source lives in the folder itself, a virtual `rcc://` folder beside it puts two different `Ctrl+S` behaviours for the same site in one window — the easiest possible way to edit the wrong copy. The tree covers the "fix one file that was never pulled" case |
| Activation | `workspaceContains:.rcc/config.json` + `onCommand:...setUpRemote` | The cleanest possible answer to "don't load in projects that don't need it" |
| View visibility | View gated on context key `rcc.hasRemote`; the container hides when every view inside it is hidden | No sidebar icon in unrelated projects. Setup is reachable from the Command Palette regardless |
| Backups | Move from `globalStorageUri` to `<folder>/.rcc/backups/` | Backups belong to the site they protect: deleting the project deletes them, and they are findable without digging through VS Code's storage |
| Duplicated `profileId` (copied project) | Detected on load; the second folder is asked to re-generate its id | Two folders sharing an id would collide in `SecretStorage` and in `rcc://` URIs |
| Sync model | Unchanged from the mirror design: **3-way** against a stored baseline | Still the only way to tell "I changed it" from "the server changed it" from "both" |

## 14.3 Layout

```
<workspace folder>/
├── .rcc/
│   ├── config.json      # the remote declaration — no secrets, safe to commit
│   ├── .gitignore       # "*" then "!config.json", "!.gitignore"
│   ├── manifest.json    # sync baseline (see §14.5)
│   ├── backups/         # <sha1(remotePath)>/<timestamp>__name — same layout as §8
│   ├── audit.log        # every MCP tool call
│   └── mcp.json         # url + token, present only while the bridge runs
├── wp-content/themes/my-theme/…    # pulled source, paths mirroring the server
└── …                               # git, notes, build tooling — the user's project
```

```jsonc
// .rcc/config.json
{
  "version": 1,
  "id": "a1b2c3d4",                 // lowercase hex, also the rcc:// authority
  "name": "TechDecoded (production)",
  "protocol": "ftp",
  "host": "techdecoded.net",
  "port": 21,
  "username": "user@techdecoded.net",
  "auth": "password",                // password lives in SecretStorage
  "remoteRoot": "/public_html",
  "readOnly": false,
  "roots": ["/public_html/wp-content/themes/my-theme"],   // subtrees under sync
  "excludes": ["wp-admin", "wp-includes", "wp-content/uploads", "**/*.log", "…"],
  "maxFileSizeKB": 1024
}
```

## 14.4 Two save paths — and how the user tells them apart

The single most likely way to lose work here is confusing the two.

| File origin | `Ctrl+S` does | Reaches the server |
|---|---|---|
| Local file in the workspace folder | writes to disk | when you run **Push Changes** |
| File opened from the remote tree (`rcc://`) | full save pipeline | immediately |

Mitigations: the status bar shows `RCC: local · 3 pending` when the active editor is a tracked local file, and `RCC: live · techdecoded.net` when it is an `rcc://` document. The first time a tracked local file is saved, a one-time notification explains that the change is local until pushed. A pending count greater than zero is always visible while the folder has a remote.

## 14.5 Sync Algorithm

`manifest.json` stores, per managed file, the baseline both sides last agreed on:

```ts
interface SyncEntry {
  remotePath: string;           // absolute; the authoritative key
  localRelPath: string;         // POSIX, relative to the workspace folder
  baseSha256: string;
  baseSize: number;
  baseRemoteMtimeMs?: number;
  baseMtimeSource: MtimeSource; // how far the mtime above can be trusted
  pulledAt: number;
  pushedAt?: number;
}
```

For each entry compare `BASE` (manifest), `LOCAL` (hash on disk), `REMOTE` (stat, hashed when the mtime source is untrustworthy):

| local vs base | remote vs base | Outcome |
|---|---|---|
| same | same | in sync |
| changed | same | **push** — the normal edit path |
| same | changed | **pull** — the server moved ahead (cPanel edit, plugin update) |
| changed | changed | **conflict** — never auto-resolved: Diff / Keep Mine / Take Server / Cancel |
| missing locally | same | offer delete on server (modal, pre-delete backup) |
| same | missing remotely | offer delete locally |
| untracked local file | absent remotely | **create** |
| untracked local file | present remotely | **conflict** — created on both sides |

Push feeds each file through `SavePipeline` (§6) and advances the baseline **only** for files it reports verified — a cancelled confirmation leaves the entry `changed`, which is the truth. `verifyByHash`: `auto` (hash only when `mtimeSource` is `listing`/`none`) | `always` | `never`; `never` is documented as unsafe on plain FTP.

## 14.6 MCP Bridge

Because the source is already local, an assistant reads and greps it with ordinary file tools. The bridge therefore carries only what a filesystem cannot express — **writes, sync, and server inspection** — which makes it far smaller than a mirror-based design would need:

| Tool | Purpose |
|---|---|
| `status()` | per-file sync state, pending count, conflicts |
| `push(paths?)` | run the pipeline; returns per-path `{status: 'written' \| 'conflict' \| 'cancelled' \| 'blocked', backupId?}` |
| `pull(remotePath?)` | refresh from the server before editing |
| `diff_with_server(remotePath)` | text diff against live bytes |
| `write_file(remotePath, content, baseSha256?)` | write a path not present locally; stale hash returns `conflict` without uploading |
| `list_dir(remotePath)`, `read_remote_file(remotePath)` | inspect parts of the site that were never pulled |
| `list_backups(remotePath)`, `restore_backup(id)` | restore goes through the pipeline, so it stays undoable |

Transport: streamable HTTP on `127.0.0.1:<mcp.port>` (default `39217`, auto-increments when busy), one server per remote-enabled folder, `Authorization: Bearer <token>` required, token generated per activation into `SecretStorage` and written to `.rcc/mcp.json`. Requests carrying a browser-style `Origin` header are refused outright — a web page must never reach a port that can write to production. **Copy MCP Config** emits the client snippet.

Results are a status enum, never a boolean: an assistant must be able to distinguish "the user pressed Cancel" from "written", or it will report a deployment that never happened.

## 14.7 Safety Model for AI Writes

1. **No bypass** — the bridge holds no client handle; it can only call `SavePipeline`, so backup, conflict check and verify are structural.
2. **Path allowlist** — `mcp.writableRoots` in the config, **empty by default**: nothing declared, every write refused. Reads unaffected.
3. **Mandatory confirmation** — `mcp.requireConfirmation` (default `true`) is independent of the human `confirmOnSave`; critical files (`wp-config.php`, `.htaccess`) always prompt.
4. **Read-only config** refuses all writes, exactly as it refuses `Ctrl+S`.
5. **Rate gate** — beyond `mcp.maxWritesPerMinute` (default 10) a single session-scoped approval is required; declining stops the burst. Guards against a runaway agent loop.
6. **Audit log** — every call appended to `.rcc/audit.log` and the OutputChannel: timestamp, tool, path, result, backup id.
7. **Kill switch** — status bar item while running, plus **Stop MCP Bridge**.

## 14.8 Migration from the global profile store

Existing installs already hold profiles in `globalState` (e.g. the "Tech" profile in current use).

- **Set Up Remote for This Folder** detects them and offers "reuse a profile from an earlier version" as the first step.
- Choosing one writes `.rcc/config.json` **keeping the original `profileId`**, then copies `globalStorage/backups/<profileId>/` into `.rcc/backups/` so existing backups stay reachable.
- Once no global profile remains unmigrated, the extension offers to clear the `globalState` key. Nothing is deleted without asking.
- `Export/Import Profiles` become **Export Remote Config** / **Import Remote Config** (the file, still without secrets).

## 14.9 Impact on Existing Code

| File | Change |
|---|---|
| `profiles/profile-store.ts` | `globalState` → read/write `.rcc/config.json`; keyed by workspace folder |
| `profiles/types.ts` | `ServerProfile` → `RemoteConfig` (adds `version`, `roots`, `excludes`, `maxFileSizeKB`) |
| `profiles/profile-wizard.ts` | becomes the Set-Up-Remote wizard; gains the migration step; drops multi-profile management |
| `profiles/profile-commands.ts` | add/edit/remove → set up / edit / disable remote for this folder |
| `extension.ts` | activation via `workspaceContains`; set `rcc.hasRemote`; watch config for changes; one manager per folder |
| `backup/backup-manager.ts` | root moves from `globalStorageUri` to `<folder>/.rcc/backups` |
| `tree/remote-tree-provider.ts` | roots = remote-enabled workspace folders instead of a global profile list |
| `package.json` | `activationEvents`, `when` clauses on the view, new commands and settings |
| `scripts/pull-remote.js` | deleted in M7; README section replaced by the real commands |
| unchanged | `connection/*`, `save/*`, `fs/*`, `core/*`, `wordpress/*` |

## 14.10 Commands & Settings

Commands: `setUpRemote` (Set Up Remote for This Folder), `editRemote`, `disableRemote`, `pull` (Pull from Server…), `push` (Push Changes…), `syncStatus` (Sync Status), `resolveConflicts`, `exportRemoteConfig`, `importRemoteConfig`, `mcp.start`, `mcp.stop`, `mcp.copyConfig`, `mcp.showAuditLog` — plus every Phase 1 tree command, unchanged.

Settings (`remoteCodeCompanion.`) added: `sync.verifyByHash` (`auto`), `sync.warnOnFirstLocalSave` (`true`), `mcp.enabled` (`false`), `mcp.port` (`39217`), `mcp.requireConfirmation` (`true`), `mcp.maxWritesPerMinute` (`10`). Per-folder values (`excludes`, `maxFileSizeKB`, `roots`, `writableRoots`) live in `.rcc/config.json`, not in settings — they belong to the site, not to the editor.

## 14.11 Milestones

### M6 — Workspace-scoped remotes (refactor of M1–M4) — **IMPLEMENTED (2026-08-14)**
Built: `profiles/{config-file,remote-config-store,setup-wizard,remote-commands,legacy-migration}.ts` (replacing `profile-store`/`profile-wizard`/`profile-commands`), backup relocation, activation and view gating, mount removal. Verified: `tsc` + ESLint clean, 42/42 unit tests (13 new for the config parser), smoke test asserting 1 remote-enabled folder out of 3 plus the gating key and the broken-config warning, integration suite unchanged and green, `vsix` packages at 808 KB. Still needs a real Extension Development Host pass with the migration path.

**Done when:** a folder with no `.rcc/config.json` shows no view and does not activate the extension; **Set Up Remote for This Folder** writes a valid config with the password in `SecretStorage` and the file free of secrets; the tree browses using that config; an existing global profile migrates with its backups intact and its `profileId` preserved; copying a project and opening both folders triggers the duplicate-id prompt; smoke and unit tests updated.

### M7 — Local source + 3-way sync — **IMPLEMENTED (2026-08-17)**
Built: `mirror/{types,classify,manifest,sync-engine,sync-commands}.ts`, sync settings, status-bar mode, local-save hook, `scripts/integration-sync-test.js`; `scripts/pull-remote.js` deleted. Verified: 72/72 unit tests (30 new — the nine-state table, hash-beats-metadata, FTP granularity, manifest reset paths) and a 10-case FTP integration suite covering pull scope, clean status, local edit, **cancelled push leaving the file pending and the server untouched**, confirmed push with backup, server-side edit, conflict refusal, take-server, create, and server-side delete.

Hardening after the first real-host pull attempt (`wp-content/themes`, i.e. four full WordPress themes) died with `ETIMEDOUT` on a new control socket: a pull is now **resumable** (already-current files are not re-fetched), it **stops immediately** on a connection failure instead of timing out once per remaining file, and a pull above 150 files or 5 MB asks first and suggests narrowing to one theme. Everything runs on one serialized connection, so a whole `themes` directory is thousands of transfers — more than most shared hosts allow in a single session.

Three bugs the tests caught, all invisible without them:
- Pull recorded the baseline mtime from `LIST` while `status()` reads it via `stat()` + `MDTM` refinement, so **every** pulled file reported `remoteChanged` forever. The baseline now comes from the same call later comparisons use.
- "Untracked local file" detection scanned only `config.roots`, which the *command* writes — calling the engine directly silently stopped detecting new files. Managed directories are now derived from the manifest as well, so the scope follows the data.
- The same timestamp trap then defeated resume: the up-to-date check compared the `MDTM` baseline against a `LIST` timestamp, so no file was ever considered current. Both sides of every comparison now come from `stat`.

**Done when:** Pull brings a real theme into the workspace folder honoring excludes and the size cap; `Ctrl+S` on those files touches only the disk and the status bar shows a pending count; Push runs the pipeline per file, leaves backups, and advances the baseline only for verified writes; a cancelled confirmation leaves the file `changed`; editing the same file locally and on the server yields a conflict that is never auto-resolved; all seven states of §14.5 are unit-tested and pull/push/conflict are covered by the integration script against `ftp-srv` and the in-process SFTP server; `scripts/pull-remote.js` removed.

### M8 — MCP bridge
**Done when:** an assistant connects with the emitted config and can `status`/`pull`/`diff_with_server`; writes route through the pipeline with a backup afterwards and the confirmation appearing even with `confirmOnSave` off; a write outside `mcp.writableRoots` is refused; a read-only config refuses all writes; a stale `baseSha256` returns `conflict` without uploading; the rate gate prompts once; requests without a token or with an `Origin` header are refused; Stop MCP Bridge frees the port; the audit log records every call.

## 14.12 Risks & Mitigations

| Risk | Mitigation |
|---|---|
| User saves a local file and believes it is live | Push is a separate, explicit action; status bar distinguishes `local · N pending` from `live · host`; one-time notification on the first local save |
| `.rcc/config.json` committed with host and username | No secret is ever written to it; `.rcc/.gitignore` keeps everything *except* the config out of git, so committing it is a deliberate choice |
| Source pulled into a folder that already has unrelated files | Pull previews the file list and refuses to overwrite an untracked local file without confirmation |
| Copied project → two folders, same `profileId` | Detected on load; the second folder is prompted to re-generate, avoiding `SecretStorage` and URI collisions |
| Backups inside the project get committed or bloat it | `.rcc/.gitignore`; retention limits from §8 apply unchanged |
| Local source holds `wp-config.php` with live DB credentials | Unavoidable once source is local — documented in README; `.rcc/.gitignore` protects the metadata, and the user chooses whether the site source itself is versioned |
| Plain FTP without MDTM makes "did the server change?" expensive | `verifyByHash: auto` downloads and hashes exactly in that case; the cost is reported in Sync Status, not hidden |
| A local port that can write to production | Opt-in, bearer token, `127.0.0.1` bind, `Origin` rejection, empty-by-default write allowlist, rate gate, audit log, kill switch |
| Runaway agent rewrites many files | Rate gate with session approval, allowlist, per-write confirmation, audit trail |
| Existing users lose their profiles in the refactor | Migration is offered on first setup, preserves `profileId`, copies backups, and clears `globalState` only after asking |

