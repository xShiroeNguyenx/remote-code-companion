# Roadmap

Where the extension is, and where it is going. The detailed design behind each
item lives in `PLAN.md`; this file is the short version, kept honest.

Current release: **0.4.0** — the first one published to the Marketplace; 0.1.0
through 0.3.0 were internal builds. Pre-1.0: the save pipeline and the connection
layer are exercised daily against a real shared host, but the API surface (config
schema, command ids) may still move between minor versions.

## Shipped

### 0.1.0 — editing production, safely (M1–M4)

- FTP / FTPS (explicit & implicit) / SFTP behind one client interface.
- Remote Explorer tree, lazy per directory; one `rcc:` FileSystemProvider serves
  both the tree and the editor.
- The save pipeline: conflict check → pre-save backup → confirmation → upload →
  size verification. `wp-config.php` and `.htaccess` always confirm.
- Backup browser: open, diff against the live server, restore, retention pruning.
- Diff with Server for the active editor.
- Read-only profiles; per-profile confirm/backup overrides.
- Passwords in VS Code SecretStorage; export/import without secrets.
- One serialized connection per server with keep-alive, idle close and a single
  transparent reconnect — shared hosts cap parallel connections hard.

### 0.2.0 — one folder, one site (M6)

- A remote is declared by `.rcc/config.json` inside a workspace folder. The
  global server list is gone, and so is the sidebar in folders without a remote.
- Backups moved to `<folder>/.rcc/backups`, beside the source they protect.
- Migration from 0.1.0 profiles keeps the id, the stored password and the backups.
- Mount as Workspace Folder removed: with local source coming, a virtual folder
  beside a real one would put two different `Ctrl+S` behaviours in one window.
- Duplicate remote ids (a copied project) are detected and offered a new id.

### 0.3.0 — local source and 3-way sync (M7)

The point of the release: stop treating the server as the only copy.

- **Pull** brings a subtree (a theme, a plugin) into the workspace folder, at
  paths mirroring the server, honoring excludes and the size cap. It refuses to
  overwrite local work without asking first.
- `Ctrl+S` on a pulled file writes to disk only. The server is touched by
  **Push Changes**, so editing is never accidental deployment. The status bar
  distinguishes `local · N pending` from `live · host`.
- A baseline in `.rcc/manifest.json` makes the three-way comparison possible:
  in sync / push / pull / conflict / deleted on either side / created on both.
  A conflict is never auto-resolved — Diff, Keep Mine, Take Server, Skip.
- Push runs every file through the same pipeline as `Ctrl+S` and advances the
  baseline only for writes it verified: a cancelled confirmation leaves the file
  `changed`, which is the truth.
- `sync.verifyByHash: auto` spends a download on hashing the server copy only
  when a timestamp cannot settle the question *and* the file also changed
  locally — the case where a wrong answer hides or invents a conflict.
- `scripts/pull-remote.js` — the stopgap helper — deleted, its job absorbed.

### 0.4.0 — seeing the change before production does (M9)

The release that closes the loop: an edit can be looked at, and a broken file
cannot reach the server.

- **Start Local Preview** runs WordPress on the machine with the pulled theme
  active. The only prerequisite is a PHP binary — WordPress is downloaded once,
  the database is SQLite via WordPress’s own integration plugin, and the web
  server is PHP’s built-in one. No MySQL, no Apache, no Docker, nothing to
  configure. The theme is linked, so an edit shows on reload.
- **Copy Production Data for Preview** makes it look like the real site: the
  server dumps its own database over SSH, and the extension imports it into a
  MariaDB instance it runs itself, on a private port with its own data directory.
  Production is only ever read, and the site URL is forced to localhost so a
  cloned database cannot redirect the browser to the live site. Media keeps
  loading from the host instead of being downloaded.
- **Push blocks on PHP syntax errors** (`php -l`), because a parse error blanks
  every page of a WordPress site rather than degrading one.
- **A Settings screen** replaces walking a chain of Quick Picks to change one
  value, and takes over the config actions that used to crowd the palette.
- Guided fixes for the failures that actually happen on cPanel hosts: a TLS
  certificate that names the server rather than your domain, an FTP sub-account
  username that cannot log in over SSH, a remote root that changes meaning with
  the protocol, passive-FTP data connections refused under load, and a dump from
  a newer MariaDB that an older client will not read.

## Next

### 0.5.0 — MCP bridge (M8)

Let an AI assistant work on the site without handing it FTP credentials.

- A local, opt-in MCP server per remote-enabled folder: `status`, `pull`, `push`,
  `diff_with_server`, `write_file`, `list_dir`, `read_remote_file`,
  `list_backups`, `restore_backup`.
- It holds no client handle: every write goes through the save pipeline, so
  backup, conflict check and verification are structural, not optional.
- Guard rails: bearer token, loopback bind, `Origin`-header rejection, a write
  allowlist that is **empty by default**, mandatory confirmation independent of
  the human setting, a rate gate against runaway loops, an audit log, and a
  kill switch in the status bar.
- Results are a status enum, never a boolean — an assistant must be able to tell
  "the user pressed Cancel" from "written".

## Toward 1.0

1.0 means the shape stops moving, not that the feature list is finished:

- Sync (M7) used long enough on real sites to trust the baseline in anger.
- `.rcc/config.json` schema frozen, with a documented migration path for `version`.
- Integration coverage for pull / push / conflict on SFTP as well as FTP (FTP is
  covered today; the SFTP path shares the engine but not the timestamp quirks).
- The known limitations below either fixed or documented as permanent.

## Backlog

Not scheduled; roughly in order of how often the need has come up.

- Multiple deploy targets per folder (production + staging) — deliberately one
  today, because "pulled from production, pushed to staging" is unrecoverable.
- Sync a whole directory tree instead of declared roots.
- A webview for first-time setup too — the Settings screen is one, but Set Up
  Remote still walks through Quick Picks.
- Permissions: show and edit `chmod` from the tree.
- Connection pool larger than 1, for hosts that allow it.
- Temp-file streaming so large files skip the in-memory buffer.
- Per-remote filename encoding for old FTP servers without UTF-8.
- Remote change watching (polling), instead of checking only when you act.

## Known limitations

Carried into 0.4.0 and unlikely to change soon:

- The copied database is a snapshot: content published on the live site afterwards
  needs another copy.
- The preview loads media from the live host rather than downloading an uploads
  folder, so it needs network access and shows production images.
- Sync Status only reports files it already tracks; a file newly created *on the
  server* appears after a Pull, not in Status.
- Plain FTP without `MDTM`: conflict detection falls back to size plus coarse
  LIST timestamps. It says so, once per server, in the output log.
- Symlinks on FTP are assumed to be directories — the `www → public_html` case.
- Non-ASCII names on servers without UTF-8 support are round-tripped as-is and
  may display wrong.
- No background watching of the server; nothing polls while you are idle.
