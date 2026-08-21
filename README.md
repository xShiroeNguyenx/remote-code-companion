# Remote Code Companion

Edit files **directly on production servers** — WordPress sites on shared hosting in particular — over **FTP, FTPS, or SFTP**. Browse the server in a tree, click a file, edit, hit `Ctrl+S`, and it uploads straight back — protected by automatic backups, conflict detection, and confirmation dialogs.

> **Pre-1.0.** 0.4.0 is the first release on the Marketplace; earlier versions were internal builds. The save pipeline and the connection layer are used daily against a real shared host, but command ids and the `.rcc/config.json` schema may still change between minor versions.

## Why

WordPress sites on cheap shared hosting (cPanel / DirectAdmin) usually have no local copy of the source. Editing through the host's web File Manager is painful. Sync-style extensions assume a local project folder; SSH-mount extensions assume you have SSH. This extension is built for the "FTP-only shared host, and it's production" workflow.

## One folder, one remote

A remote belongs to a **workspace folder**, declared by `.rcc/config.json` inside it. There is no global server list: open a project that has no such file and the extension does not even load. So a site becomes a folder you open, work in, and close.

The config file holds no secrets — the password lives in the OS keychain — so it is safe to commit if you want your team to share the connection details.

## Features

- **FTP / FTPS (explicit & implicit) / SFTP** — covers every shared host.
- **Remote Explorer tree**: lazy-loads directories on expand; VS Code never crawls or indexes the server.
- **Pull a theme or plugin into the folder** and work on it as ordinary local code — full-text search, IntelliSense, git, or an AI assistant all just work. **Push Changes** sends it back, file by file, through the same safety pipeline. A three-way baseline distinguishes *you* changed it from *the server* changed it from *both did* — and a conflict is never resolved for you.
- **Upload one file, without a scan** — right-click a file in the Explorer (or its editor tab) and pick **Upload to Server**. When you already know which file you changed, there is no reason to compare the whole mirror against the server first. On a folder, **Upload Changed Files in This Folder** sends what differs there and leaves identical files alone. Multi-selection works, and everything still travels through the pipeline below.
- **Production-safety save pipeline**, in order on every `Ctrl+S`:
  1. **Conflict check** — did the file change on the server since you opened it?
  2. **Automatic backup** — the current server version is downloaded to local storage *before* it is overwritten. Backup failure blocks the save by default.
  3. **Confirmation** — one dialog, not a chain of them: the full remote path, the size, how many lines differ from the server copy, and whether the backup succeeded. **Always** shown for `wp-config.php` and `.htaccess`, for a file that changed on the server, and when a backup failed — even with confirmations turned off. Set `confirm.style` to `modal` for VS Code’s own dialog instead.
  4. Upload, then **verify** the size on the server.
- **Local preview before you push** — **Start Local Preview** runs a real WordPress site on your machine with the pulled theme active, so an AI’s change can be looked at before production sees it. It needs only a PHP binary: WordPress is downloaded once, the database is SQLite, and the server is PHP’s built-in one. The theme is linked, so edits show on reload.
- **Copy Production Data for Preview** — the server dumps its own database over SSH, and the extension imports it into a MariaDB instance it runs itself, so the preview shows the real content with the real plugins. Production is only read; media keeps loading from the live host instead of being downloaded.
- **Push blocks on PHP syntax errors** — every `.php` file is checked with `php -l` first, because a parse error blanks every page of a WordPress site.
- **Browse Backups** — open, diff against the live server, or restore any backup. Restores go through the same pipeline, so they are undoable too.
- **Diff with Server** — compare your (possibly unsaved) editor buffer with the live server version at any time.
- **Read-only remotes** — for "just looking" sessions on production.
- **Passwords in the OS keychain** (VS Code SecretStorage) — never in settings or in `.rcc/config.json`. An exported config contains no secrets.
- Shared-hosting-aware connection handling: a single serialized connection per server, keep-alive, idle auto-close, automatic reconnect with a single retry.

## Installing

From the **VS Code Marketplace**, or from **Open VSX** if you use VSCodium, Gitpod or
Eclipse Theia. Both carry the same build.

## Requirements

- VS Code **1.85** or newer.
- An FTP, FTPS or SFTP account on the server. SFTP takes either a password or a private key file with an optional passphrase.
- **Nothing is installed on the server.** No agent, no PHP helper, no plugin — the extension speaks the transfer protocol and nothing else.

Optional, and only for the local preview:

- **PHP** on your machine (the command-line binary) to run the preview at all. A broken `php.ini` does not matter: PHP is always invoked with `-n`.
- **MySQL or MariaDB** on your machine to copy production data into. XAMPP includes one; the extension runs its own instance on a private port and never touches yours.
- **SSH access** on the host for *Copy Production Data*, since the database dump has to be produced on the server. Everything else works over plain FTP.

## Quick start

1. Create a folder for the site and open it in VS Code.
2. Command Palette → **Remote Code Companion: Set Up Remote for This Folder** → follow the wizard (protocol, host, credentials, remote root — it suggests `public_html` when it sees one).
3. The **Remote** view appears in the Activity Bar. Expand it, click a file, edit, save.

Upgrading from an earlier version? Setup offers your existing servers as the first step and keeps their stored password and backups.

## Two ways to edit, and how to tell them apart

Losing work here would mean confusing the two, so the status bar always says which one you are in:

| What you opened | `Ctrl+S` does | Reaches the server |
|---|---|---|
| A local file that was pulled into the folder | writes to disk | when you run **Push Changes** |
| A file opened from the Remote tree (`rcc://`) | the full save pipeline | immediately |

`RCC: local · 3 pending` means three files are waiting for a push — click it to push. `RCC: live · your-host` means you are editing the server copy directly.

## Where things live

```
<your folder>/
├── .rcc/
│   ├── config.json    # the remote declaration — no secrets, safe to commit
│   ├── .gitignore     # keeps everything below out of git
│   ├── manifest.json  # sync baseline: what local and server last agreed on
│   └── backups/       # safety copies taken before each overwrite
└── wp-content/…       # source pulled from the server, at matching paths
```

## Commands

Day-to-day actions live under the **Remote Code Companion** category in the Command Palette. File operations sit in the tree's context menu, and anything that configures the folder lives on the **Settings** screen rather than cluttering the palette.

| Command | What it does |
|---|---|
| Set Up Remote for This Folder | The wizard: protocol, host, credentials, remote root. Writes `.rcc/config.json` |
| Settings | One screen for the connection, credentials, sync scope, excludes, editor-wide options — and for exporting/importing the config, resetting the preview, or disabling the remote |
| Pull from Server… | Copy a subtree (a theme, a plugin) into this folder as ordinary local files |
| Push Changes… | Send locally edited files to the server, each through the full save pipeline |
| Upload to Server | Right-click a file (Explorer, editor tab, or editor) to send exactly that file — no sync scan first. A folder sends only what differs |
| Sync Status | Per-file state: in sync, needs push, needs pull, or conflicted |
| Start / Stop / Open Local Preview | Run the pulled theme in a throwaway local WordPress and open it in the browser |
| Copy Production Data for Preview | Dump the live database over SSH and import it locally, so the preview matches the real site |
| Reset Local Preview Site | Delete the local site and its database; the theme files are untouched |
| Resolve Conflicts | Walk each conflicted file: Diff, Keep Mine, Take Server, Skip |
| Connect / Disconnect | Open or close the connection by hand |
| Diff with Server | Compare the active editor against the live file |
| Browse Backups / Restore Latest Backup | Open, diff or restore a pre-overwrite copy |
| Download… / Upload File Here… | Move a file between disk and server without opening it |
| New File / New Folder / Rename / Delete | Ordinary file operations, on the server |
| Export / Import Remote Config | Share the connection details (never the password) |
| Show Output Log | Every protocol operation, with reasons for failures |

## Settings

Most of the time you want the **Settings** screen — the gear in the Remote view title, or `Remote Code Companion: Settings`. It shows the folder’s connection, credentials, synced subtrees, exclude globs and the editor-wide options on one page, with Save and Test connection. Editing `.rcc/config.json` by hand also works; the extension reloads it on save.

The editor-wide values below are ordinary VS Code settings, so they can also be set per user or per workspace in `settings.json`.

| Setting | Default | Meaning |
|---|---|---|
| `remoteCodeCompanion.confirmOnSave` | `true` | Ask before every upload (per-remote override available in `.rcc/config.json`) |
| `remoteCodeCompanion.confirm.style` | `panel` | `panel`: a styled confirmation showing the whole remote path, the size and the line delta. `modal`: VS Code’s own window-blocking dialog |
| `remoteCodeCompanion.conflictCheck` | `true` | Detect server-side changes since the file was opened |
| `remoteCodeCompanion.backup.enabled` | `true` | Back up the server version before overwrite/delete |
| `remoteCodeCompanion.backup.required` | `true` | A failed backup blocks the save (asks first) |
| `remoteCodeCompanion.backup.maxPerFile` / `maxAgeDays` | `10` / `30` | Backup retention |
| `remoteCodeCompanion.connection.idleTimeoutSeconds` | `300` | Close idle connections cleanly |
| `remoteCodeCompanion.maxFileSizeMB` | `10` | Refuse to open larger files (use Download) |
| `remoteCodeCompanion.tree.excludes` | caches, `node_modules`, `.git` | Globs hidden from the tree |
| `remoteCodeCompanion.wordpress.warnCriticalFiles` | `true` | Always confirm `wp-config.php` / `.htaccess` uploads |
| `remoteCodeCompanion.sync.verifyByHash` | `auto` | When to hash the server copy to decide if it changed (`auto` / `always` / `never`) |
| `remoteCodeCompanion.sync.warnOnFirstLocalSave` | `true` | Explain once that a local save waits for a push |
| `remoteCodeCompanion.sync.pullDelayMs` | `100` | Pause between transfers in a pull, so a burst of FTP data connections does not trip the host’s flood protection |
| `remoteCodeCompanion.php.lintBeforePush` | `true` | Block a push when a PHP file fails `php -l` |
| `remoteCodeCompanion.php.path` | `""` | PHP executable; empty means find one automatically |
| `remoteCodeCompanion.mysql.binDir` | `""` | Folder holding `mysqld`, for the preview database; empty means find one automatically |

## Security & privacy

- The password is stored in VS Code's SecretStorage, which is the OS keychain (Windows Credential Manager, macOS Keychain, libsecret). It is never written to settings, to `.rcc/config.json`, or to the output log.
- `.rcc/config.json` contains host, username and paths — no credentials. Committing it is a deliberate, safe choice; `.rcc/.gitignore` keeps backups and other local state out of git.
- FTP is a cleartext protocol: the password and the file contents cross the network in the open. Prefer FTPS or SFTP whenever the host offers it. The extension does not warn you again after setup.
- Nothing is sent anywhere except to the server you configured. There is no telemetry.

## Choosing a protocol on shared hosting

- **SFTP** is the best option when the host offers SSH. It carries every file over one connection, so it avoids both the passive-port problems and the connection-flood blocks that plain FTP runs into on busy shared hosts. It uses the main cPanel account, not an FTP sub-account.
  The username is the **main cPanel account** (something like `techdeco`), not the `user@domain` name of an FTP sub-account — that form cannot log in over SSH. If the host allows SSH keys only, generate one in cPanel > SSH Access, click **Authorize** on the public key, download the private key, and point *Private key path* at it.
  The **remote root also changes** with the protocol: an FTP sub-account is locked into its own directory and sees `/public_html`, while SSH sees the same directory as `/home/<account>/public_html`. The extension offers the corrected path when a root turns out not to exist.
- **FTPS** encrypts, but a shared host almost never has a certificate for *your* domain — it presents the server’s own name. Connecting as that name keeps verification intact; the alternative is to skip the certificate check, which the extension offers explicitly rather than silently.
- **FTP** works everywhere and is the fallback. It is cleartext, and every transfer opens a new connection on a high port, which is what makes large pulls fragile.

## Previewing before you push

Two levels, depending on how much you need it to look like production:

1. **Start Local Preview** — WordPress plus your theme, on an empty database. Needs only a PHP binary. Good for "does it render, does it error".
2. **Copy Production Data for Preview** — the same site with a copy of the live database and the real plugins. Needs a local MySQL/MariaDB as well; XAMPP includes one and nothing has to be configured or started by hand.

What it does *not* do: it never writes to production. The dump is read-only from the server’s point of view, the copied database is local, and the site URL is forced to localhost so a cloned database cannot bounce your browser to the live site. Media files stay on the server and load from there.

The copy is a snapshot. Content added on the live site afterwards will not appear until you copy again.

## Notes & limitations

- On plain FTP servers without `MDTM` support, conflict detection degrades to file-size + coarse LIST dates (it tells you once per server in the output log).
- Symbolic links on FTP are assumed to be directories (the common `www → public_html` case).
- Old FTP servers without UTF-8 support may show non-ASCII names incorrectly; names are round-tripped as-is.
- No remote change *watching* — the server is polled only when you act.
- Sync Status compares the files it already knows about. A file newly **created on the server** shows up after a Pull, not in Status.
- Pull never follows symlinks, and skips files above `maxFileSizeKB` (declared per remote in `.rcc/config.json`).
- **Pull one theme or plugin at a time.** Everything runs over a single FTP connection, so pulling all of `wp-content/themes` means thousands of transfers and most shared hosts will cut the session partway. A pull above 150 files asks for confirmation, and if it does get cut off, running it again resumes — files already up to date are not fetched twice.

## Roadmap

Next up is the **MCP bridge**, so an AI assistant can work on the site through the same safety pipeline instead of being handed FTP credentials. `ROADMAP.md`, included with the extension, has the detail.

## Development

```bash
npm install
npm run compile        # tsc → out/
npm run lint           # eslint over src/
npm test               # smoke test (mocked vscode) + unit tests (node:test)
npm run test:integration  # real FTP (ftp-srv) + SFTP (ssh2) servers in-process
npm run test:preview      # builds a real WordPress locally and renders a theme (downloads ~31 MB once)
npm run test:mysql        # private MariaDB instance + WordPress running against it
npm run verify:package    # what the vsix would contain
npm run verify:runtime    # the packaged tree really loads (catches a missing dependency)
npm run package        # .vsix via vsce
```

Press `F5` in VS Code to launch an Extension Development Host.

CI runs lint, compile, unit/smoke and integration tests on Linux and Windows for
every push and pull request, and packages the `.vsix` to prove it stays clean.
`RELEASE.md` documents how a version reaches the Marketplace.

## Contributing

Issues and pull requests are welcome. Before opening a PR: `npm run lint`,
`npm test` and `npm run test:integration` should all pass, and a user-visible
change belongs in `CHANGELOG.md` under an `Unreleased` heading. `npm run test:preview`
and `npm run test:mysql` are worth running when touching the preview; they are kept
out of CI because they download WordPress and need a local database.

## License

MIT
