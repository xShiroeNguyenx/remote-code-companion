# Changelog

## 0.5.0

**Send one file, and see what you are sending.** Two changes to the moment a file leaves for production.

- **Upload to Server** on the right-click menu of a file — in the Explorer, on the editor tab, or inside the editor. When you already know which file you changed, comparing the whole mirror against the server first is a wait for an answer you had before you started; this asks the server about that one file and uploads it. Multi-selection works, and so does **Upload Changed Files in This Folder** on a directory, which sends what differs there and leaves byte-identical files alone.
- Nothing about the safety pipeline is skipped — only the scan. Backup, conflict check, confirmation, upload and size verification all still run, and the sync baseline still advances only for a file the pipeline reported as verified.
- A file the sync state calls conflicted is no longer silently relabelled to get it through. **Upload to Server** and **Keep mine** now push it as what it is, and the dialog says so: *"changed on the server since you opened it — uploading discards that change."* The decision is still the user's; it is just no longer a separate dialog.
- A file the server no longer has, or one that exists there but was never pulled, is now named as such before it is overwritten instead of failing or overwriting quietly.
- **The confirmation dialog was rebuilt.** VS Code's own modal cannot be styled and truncates a long remote path to one ellipsised line — precisely the line that answers *am I about to overwrite the right file?* The new dialog shows the whole path, the file size against the size it replaces, **how many lines differ from the server copy**, and the state of the backup, with the server name, host and protocol in the header. `Enter` uploads, `Esc` cancels, and closing the tab counts as cancelling — never as consent.
- The line delta is free: the pre-save backup already downloads the server copy, so the comparison costs no extra transfer. Binary files are left out of it rather than guessed at.
- **One dialog per save, not a chain of them.** A server-side change, a failed backup and a critical file used to be three modals in a row, which is how people learn to click through without reading. They are now rows inside the single question, and any of them still forces the dialog to appear even with confirmations turned off.
- A multi-file or folder upload is confirmed **once**, listing every file. The pipeline then only stops again for files where something is actually wrong — a conflict, a critical file, a failed backup.
- **"Stop asking for this remote"** is a checkbox in the dialog; it writes the per-remote override into `.rcc/config.json`, because "stop asking about this site" is not "stop asking about every site". It is deliberately absent whenever the dialog is up because something is risky: silencing a warning must not be a side effect of answering it.
- `remoteCodeCompanion.confirm.style` switches back to the native modal for anyone who would rather not have a tab open for a confirmation. That path also gained the full remote path and the same facts.
- The dialog escapes everything it renders, and its script is nonce-gated under a `default-src 'none'` policy — a file name is attacker-controlled often enough in a pulled plugin.

## 0.4.0

**First public release**, on both the VS Code Marketplace and Open VSX. 0.1.0 to 0.3.0 were internal builds, kept below
because the schema and command changes between them still describe how the extension
got here.


**See the change before it reaches production.** Two new safety nets around a push.

- **Start Local Preview** runs a real WordPress site on your machine with the pulled theme activated, then opens it in the browser. It needs nothing but a PHP binary: WordPress core is downloaded once and cached, the database is SQLite via WordPress’s own integration plugin, and the web server is PHP’s built-in one. No MySQL, no Apache, no Docker, and nothing to configure.
- The theme is **linked** into the preview, not copied, so an edit shows up on the next reload — which is the point when checking what an AI just wrote.
- PHP is always invoked with `-n`, ignoring php.ini entirely, and only extensions that exist as real files are loaded. A machine with a broken php.ini — a corrupt `extension_dir` is common — still gets a working preview instead of a wall of startup warnings.
- **Push now blocks on PHP syntax errors.** Every `.php` file a push would upload is checked with `php -l` first; anything that cannot be parsed is held back, with the file and line reported. A parse error does not degrade a WordPress site, it blanks every page of it, so it is worth stopping for. Configurable via `php.lintBeforePush`, and skipped with a log note when no PHP is present.
- **Copy Production Data for Preview** makes the preview look like the real site. The server is asked to dump its own database with `mysqldump` over SSH, the dump is downloaded and imported into a MariaDB instance the extension runs itself — its own data directory, its own port, never the one you already have. The temporary dump on the server is deleted afterwards, including when the dump fails.
- Production is only ever read. `WP_HOME`/`WP_SITEURL` are defined locally so a copied database cannot redirect the browser to the live site, and the local install is marked as a local environment.
- **Media is not downloaded.** Image URLs in post content keep pointing at the live host, so pages look right without transferring an uploads folder that is usually gigabytes.
- Plugins pulled into the workspace are linked into the preview, because a theme that calls a plugin renders blank without it.
- The database password is passed to `mysqldump` through an environment variable, never on the command line, so it cannot appear in the process list of a shared host.
- The dump is made importable by an older client. MariaDB 10.11+ prepends a "sandbox mode" directive whose `\-` command a client from an older XAMPP does not recognise, and the import stopped at line 1 with "Unknown command". That line is a client instruction, not data, so it is removed.
- The dump content is checked before import. A shell pipeline reports the status of its *last* command, so `mysqldump | gzip > file` succeeds even when mysqldump failed — leaving a valid gzip file full of nothing useful. A dump with no table statements is now reported with what it actually contained, instead of failing later as a confusing SQL error.
- The real table prefix from `wp-config.php` is carried into the local install. WordPress sites rarely use `wp_`; with the wrong prefix WordPress finds no tables, concludes it is not installed, and serves its installer — a preview that looks empty while the data is right there.
- **Stop Local Preview** and **Reset Local Preview Site** for cleanup; the preview stops automatically when the window closes. Deleting a site waits for the server process to release its handles first, which Windows needs.
- The preview site lives in extension storage, never in the workspace folder, so it cannot add files to what a push would upload.
## 0.3.0

Internal build. **Local source with three-way sync.** The server stops being the only copy.

- **A Settings screen.** The gear in the Remote view opens one page with the connection, the stored password, the synced subtrees, the exclude globs and every editor-wide option — instead of walking a chain of Quick Picks to change one value. Saving validates through the same parser that loads the file, so the panel cannot write a config the extension would then refuse.
- The command palette is shorter: 22 entries down to 17. **Edit Remote** is gone entirely — the Settings screen covers every field it asked for, and has Test connection too. Export/Import Remote Config, Disable Remote and Reset Local Preview Site moved onto that screen and out of the palette; they remain available from the tree context menu.
- New app icon.
- **FTPS certificate mismatch is now actionable.** Shared hosts present the certificate of the machine (`dal220.example-host.com`), not of your domain, so an FTPS connection fails on the host name. The dialog now names the hosts the certificate is valid for and offers either connecting as one of them (verification stays on) or skipping the check (labelled as losing man-in-the-middle detection).
- **Rejected credentials now say what is probably wrong.** cPanel FTP sub-accounts are named `user@domain` and cannot log in over SSH at all, so a profile switched from FTP to SFTP keeps a username that can never work. The dialog names the bare account to try instead, mentions that many hosts accept SSH keys only, and the Settings screen flags the mismatched username on the field itself — before you press Test.
- **A missing remote root offers the right path instead of just failing.** The same directory has two names: an FTP sub-account is chrooted so it sees `/public_html`, while SSH logs in as the real account and the same place is `/home/<account>/public_html`. Switching protocol therefore invalidates the root. The dialog now offers the corrected path, and accepting it also re-points the synced subtrees so they do not dangle. The Settings screen shows the same suggestion under the field.
- Connect (from the tree) reports failures through the same guided dialogs as Test connection, rather than echoing the raw error.
- **Pull from Server…** copies a subtree into the workspace folder at paths mirroring the server, honoring the per-remote excludes and size cap. It counts how many local files a pull would overwrite — separating "has unpushed edits" from "was never pulled" — and asks before discarding any of them.
- **`Ctrl+S` on a pulled file writes to disk only.** The server is reached through **Push Changes…**, which runs each file through the same pipeline as a direct save: conflict check, pre-save backup, confirmation, upload, size verification.
- The status bar distinguishes `RCC: local · N pending` from `RCC: live · host`, so the two save behaviours are never ambiguous. A one-time notice explains the first local save.
- **Sync Status** reports nine states from a baseline in `.rcc/manifest.json`: in sync, edited locally, changed on the server, conflicted, deleted on either or both sides, created locally, created on both. **Resolve Conflicts** walks them with Diff / Keep Mine / Take Server / Skip — nothing is auto-resolved.
- A baseline advances **only** after a write the pipeline verified. A cancelled confirmation leaves the file pending, which is the truth; the alternative would be claiming a deploy that never happened.
- `sync.verifyByHash` (`auto` by default) downloads and hashes the server copy only when a timestamp cannot settle the question and the file also changed locally.
- **Pull is resumable.** Shared hosts drop long FTP sessions; a pull that gets cut off keeps what it fetched, says how many files were left, and offers to continue. Re-running it skips files that are already up to date instead of downloading the subtree again.
- A pull larger than 150 files or 5 MB asks first, and suggests pulling a single theme or plugin instead — on one serialized connection, a whole `themes` directory is thousands of transfers.
- Losing the connection mid-pull now stops immediately instead of attempting every remaining file and timing out on each, which turned one clear failure into a very long hang.
- Timestamps are only ever compared like-for-like. The baseline holds a `stat`-sourced time (`MDTM`, exact UTC), so both the pull baseline and the up-to-date check ask `stat` again; comparing that against an `LIST` timestamp (minute precision, unknown timezone) reported changes that never happened — it made every pulled file look modified on the server, and it defeated resume.
- `scripts/pull-remote.js`, the stopgap pull helper, is removed — the commands replace it.
- Pull paces itself: `sync.pullDelayMs` (100 ms by default) sits between transfers. Every FTP transfer opens a fresh passive data connection, and shared hosts run flood protection that reads a rapid burst of them as an attack and blocks the IP.
- A failed passive data connection is now recognised as a connection failure, so the connection layer retries it once on a fresh session and a pull that still cannot transfer stops immediately instead of timing out on every remaining file.
- When a pull is cut off by a data-connection failure, the dialog names the three real causes — host flood protection, a network that blocks high ports, or plain FTP being the wrong tool — rather than only echoing the socket error.

## 0.2.0

Internal build. The release where a remote starts belonging to a workspace folder instead of the editor. One folder, one site.

Upgrading from 0.1.0: nothing is lost. Your existing servers stay in place until you attach them — **Set Up Remote for This Folder** offers them as its first step and carries over the stored password and backups.

- Server profiles moved out of global storage into `.rcc/config.json` in the folder they belong to. The file carries no secrets and can be committed; passwords stay in the OS keychain.
- The extension only activates where such a file exists, and the sidebar is hidden entirely in folders without a remote.
- **Set Up Remote for This Folder** replaces Add Server; it offers existing profiles from the previous version as its first step, preserving their id, stored password and backups.
- Backups moved from VS Code global storage to `<folder>/.rcc/backups`, beside the source they protect. `.rcc/.gitignore` is written on setup so only the config is versionable.
- Commands renamed: Edit Server → **Edit Remote**, Remove Server → **Disable Remote for This Folder**, Export/Import Profiles → **Export/Import Remote Config**. Duplicate Server is gone.
- **Mount as Workspace Folder removed.** With source destined to live in the folder itself, a virtual `rcc://` folder beside it would put two different `Ctrl+S` behaviours in one window — the easiest possible way to edit the wrong copy.
- A copied project (two folders sharing one remote id) is detected on load and offered a new id, rather than colliding in the keychain and in `rcc://` URIs.
- An unusable `.rcc/config.json` is reported with an action to open it, instead of leaving the view mysteriously empty.

## 0.1.0

Internal build. Listed because 0.2.0 upgrades from it.

- FTP / FTPS (explicit & implicit) / SFTP support with per-server profiles.
- Remote Explorer tree (lazy) + optional Mount as Workspace Folder — both backed by one `rcc:` FileSystemProvider.
- Production-safety save pipeline: conflict check → automatic pre-save backup → confirmation (always for `wp-config.php` / `.htaccess`) → upload → size verification.
- Backup browser with open / diff-vs-server / restore / prune (per-file count + age retention).
- Diff with Server command for the active editor.
- Read-only profiles, per-profile confirm/backup overrides.
- Secrets in VS Code SecretStorage; profile export/import without secrets.
- Serialized single connection per server with keep-alive, idle close, and one-shot reconnect — tuned for shared hosting connection caps.
