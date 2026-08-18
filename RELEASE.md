# Releasing

How a version reaches the **VS Code Marketplace** and **Open VSX**. Maintainer-only;
this file is not shipped in the `.vsix`.

Both registries receive the *same* vsix. Open VSX is what VSCodium, Gitpod and
Eclipse Theia install from — they cannot use the Microsoft Marketplace, so publishing
only there would leave those users unable to install the extension at all.

**0.4.0 is the first public release.** 0.1.0 to 0.3.0 were internal builds and were
never published, which is why the Marketplace listing starts at 0.4.0 while the
changelog goes further back.

## One-time setup

None of this is done yet. Steps 1 and 2 are required for the Marketplace, step 3 for
Open VSX; 4 and 5 only matter once the code is on GitHub.

### 1. Publisher

The `publisher` in `package.json` is `shiroenguyen`. It must exist on the
Marketplace and be owned by an Azure DevOps organisation you control:

1. Create an Azure DevOps organisation — <https://dev.azure.com>.
2. Create the publisher — <https://marketplace.visualstudio.com/manage> →
   **Create publisher**, id `shiroenguyen`. The id cannot be changed later, and it
   is the first half of the extension's permanent identifier
   `shiroenguyen.remote-code-companion`.

### 2. Personal Access Token

In Azure DevOps → **User settings → Personal Access Tokens → New Token**:

- Organization: **All accessible organizations** — not a single one, or publishing
  fails with a confusing 401.
- Scopes: **Custom defined** → **Marketplace → Manage**.
- Expiry: whatever you will remember to rotate; a year is the maximum.

Copy the token once — it is never shown again.

### 3. Open VSX account, namespace and token

Open VSX is an Eclipse Foundation registry, so the sign-up differs from the
Marketplace:

1. Sign in at <https://open-vsx.org> **with GitHub** — it is the only method.
2. Sign the Publisher Agreement: <https://open-vsx.org/user-settings/extensions>
   prompts for it. Publishing fails until it is signed, with an error that does not
   say so plainly.
3. Create an access token: <https://open-vsx.org/user-settings/tokens>. Copy it once.
4. Claim the namespace, which must equal `publisher` in `package.json`:

```bash
export OVSX_PAT=<token>          # PowerShell: $env:OVSX_PAT = "<token>"
npm run ovsx:namespace           # creates the "shiroenguyen" namespace
```

A namespace is free to create but, like the Marketplace publisher id, permanent.
Until someone claims it, an extension published under it is marked unverified on
the listing.

### 4. Repository and CI secret

The repo is not on GitHub yet. When it is:

```bash
git init
git add .
git commit -m "Remote Code Companion 0.4.0"
git branch -M main
git remote add origin git@github.com:<OWNER>/remote-code-companion.git
git push -u origin main
```

Then add the tokens: repo **Settings → Secrets and variables → Actions → New
repository secret** — `VSCE_PAT` for the Marketplace, and `OVSX_PAT` for Open VSX.
Open VSX is skipped rather than failed when its secret is absent, so a release is
never blocked by it.

Optionally require an approval before every publish: **Settings → Environments →
marketplace → Required reviewers**. The release workflow already targets that
environment.

### 5. Fill in the repository fields

`package.json` has no `repository`, which is why every `vsce` call carries
`--allow-missing-repository`. Once the repo exists, add:

```jsonc
  "repository": { "type": "git", "url": "https://github.com/<OWNER>/remote-code-companion.git" },
  "bugs": { "url": "https://github.com/<OWNER>/remote-code-companion/issues" },
  "homepage": "https://github.com/<OWNER>/remote-code-companion#readme",
```

and drop `--allow-missing-repository` from the `package` script in `package.json`
and from `.github/workflows/*.yml`.

Only then may `README.md` use relative links or images: without a repository,
`vsce` cannot rewrite them and refuses to package. Today every link in the README
is absolute, which is what keeps packaging working.

## Before every release

Automated checks:

- [ ] `npm run lint`
- [ ] `npm test` — smoke test plus unit tests.
- [ ] `npm run test:integration` — in-process FTP and SFTP servers.
- [ ] `npm run verify:package` — no sources, sourcemaps, native bindings or build
      tooling in the vsix, and every runtime dependency present.
- [ ] `npm run verify:runtime` — every runtime module actually loads from a tree
      containing only what the vsix ships. This is what catches a dependency that
      resolves in development and throws `MODULE_NOT_FOUND` for a user.

Not in CI, because they download WordPress and need a local database. Run them
when the release touches the preview:

- [ ] `npm run test:preview` — builds a real WordPress and renders a theme.
- [ ] `npm run test:mysql` — private MariaDB instance with WordPress against it.

Housekeeping:

- [ ] `CHANGELOG.md` has a section for the new version. The release workflow
      refuses to publish without one.
- [ ] `version` bumped in `package.json`, then `npm install --package-lock-only`
      so the lockfile agrees.
- [ ] `README.md` reflects what actually ships. It **is** the Marketplace listing,
      and it is the first thing a stranger judges the extension by.
- [ ] `ROADMAP.md` current-release line updated, and anything now shipped moved out
      of *Next* and out of *Backlog*.

Manual pass — the part no test replaces:

- [ ] In the Extension Development Host (`F5`), against a real host: set up a
      remote, browse, pull a theme, edit, push. Confirm a backup appeared under
      `.rcc/backups`, and trigger the conflict modal by editing the same file on
      the server first.
- [ ] Install the built vsix in a clean VS Code and repeat one save. This is the
      only test that exercises the packaged dependency tree:
      `code --install-extension remote-code-companion-<version>.vsix`.
- [ ] Open a folder with no `.rcc/config.json` and confirm the sidebar is absent —
      the extension must stay invisible where it is not wanted.

## Publishing

```bash
git tag v0.4.0
git push origin v0.4.0
```

The tag triggers `.github/workflows/release.yml`, which refuses to continue if the
tag disagrees with `package.json`, if the CHANGELOG has no section for the version,
if any test fails, if the package contents are wrong, if `VSCE_PAT` is missing, or
if that version is already on the Marketplace. Only then does it publish and attach
the vsix as a build artifact.

To rehearse without publishing: **Actions → Release → Run workflow** with **dry
run** left checked. It builds and verifies, and stops before publishing.

### Without GitHub Actions

The same thing by hand, from a clean checkout:

```bash
npm ci
npm run lint && npm test && npm run test:integration
npm run package                     # compile + verify + build the vsix
npx vsce login shiroenguyen         # paste the Marketplace PAT once
npx vsce publish --allow-missing-repository --packagePath remote-code-companion-0.4.0.vsix

export OVSX_PAT=<token>             # PowerShell: $env:OVSX_PAT = "<token>"
npm run publish:ovsx                # same vsix, to Open VSX
```

## After publishing

- The Marketplace listing takes a few minutes to appear, and re-verifies the package
  before it goes live; a failed verification arrives by email. Open VSX is usually
  immediate.
- Check the rendered listing: icon, description, README, categories, and that no
  link is broken.
- A published version cannot be replaced on either registry — only superseded by a
  higher one. If something is wrong, fix it and release a patch. `vsce unpublish`
  removes the whole extension, not one version, and frees the name for nobody.
- Check both listings: <https://marketplace.visualstudio.com/items?itemName=shiroenguyen.remote-code-companion>
  and <https://open-vsx.org/extension/shiroenguyen/remote-code-companion>.

## Versioning

Pre-1.0, the minor number carries the breaking changes:

- `0.2.0` moved remotes from global storage into `.rcc/config.json`.
- `0.3.0` introduced local source and the two save paths.
- `0.4.0` added the local preview and the pre-push PHP check, and removed the
  `editRemote` command in favour of the Settings screen.

Patches are fixes that change no schema and no command id. 1.0.0 is the point where
`.rcc/config.json` stops moving — see `ROADMAP.md`.
