import * as fs from 'fs';
import * as vscode from 'vscode';
import { testProfileConnection } from '../connection/connection-manager';
import { RemoteCredentials } from '../connection/types';
import { Logger } from '../core/logger';
import { newProfileId } from '../core/rcc-uri';
import { joinRemote, normalizeRemotePath } from '../core/remote-path';
import { suggestRootCandidates } from '../wordpress/wp-heuristics';
import { configFromProfile } from './config-file';
import { ProfileSecrets } from './profile-secrets';
import { authFailureAdvice, isAuthFailure, parseCertMismatch } from '../core/connect-advice';
import { AuthMethod, defaultPort, Protocol, protocolLabel, RemoteConfig, ServerProfile } from './types';

/** Blank line between paragraphs in a modal detail. */
const DIALOG_GAP = `

`;

export interface SetupWizardOptions {
  folder: vscode.WorkspaceFolder;
  secrets: ProfileSecrets;
  logger: Logger;
  /** Present when editing the folder's existing remote. */
  existing?: RemoteConfig;
  /** Phase 1 profiles still in globalState, offered for reuse on first setup. */
  legacy?: ServerProfile[];
}

export interface SetupWizardResult {
  config: RemoteConfig;
  /** Set when the config was adopted from a Phase 1 profile, so backups can follow. */
  migratedFrom?: ServerProfile;
}

/**
 * Declares (or edits) the remote for one workspace folder. Secrets go straight
 * to SecretStorage; the returned config is safe to write to disk.
 */
export async function runSetupWizard(opts: SetupWizardOptions): Promise<SetupWizardResult | undefined> {
  const { folder, secrets, logger, existing, legacy } = opts;
  const editing = existing !== undefined;

  // Reusing a Phase 1 profile keeps its id, so its password and backups still apply.
  if (!editing && legacy && legacy.length > 0) {
    const reuse = await pickLegacyProfile(legacy, folder);
    if (reuse === undefined) {
      return undefined;
    }
    if (reuse !== 'new') {
      const config = configFromProfile({ ...reuse, updatedAt: Date.now() });
      const confirmed = await testAndRefine(config, secrets, logger);
      return confirmed ? { config: confirmed, migratedFrom: reuse } : undefined;
    }
  }

  const id = existing?.id ?? newProfileId();
  const steps = editing ? 'Edit Remote' : 'Set Up Remote';

  const name = await vscode.window.showInputBox({
    title: `${steps} — Name`,
    prompt: 'A label for this server',
    value: existing?.name ?? folder.name,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Name is required')
  });
  if (name === undefined) {
    return undefined;
  }

  const protocolPick = await vscode.window.showQuickPick(
    (['ftp', 'ftps', 'ftps-implicit', 'sftp'] as Protocol[]).map((p) => ({
      label: protocolLabel(p),
      description: p === existing?.protocol ? 'current' : undefined,
      protocol: p
    })),
    { title: `${steps} — Protocol`, placeHolder: 'How do you connect to this host?', ignoreFocusOut: true }
  );
  if (!protocolPick) {
    return undefined;
  }
  const protocol = protocolPick.protocol;

  const host = await vscode.window.showInputBox({
    title: `${steps} — Host`,
    prompt: 'Hostname or IP address',
    value: existing?.host ?? '',
    placeHolder: 'ftp.example.com',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Host is required')
  });
  if (host === undefined) {
    return undefined;
  }

  const portDefault = existing && existing.protocol === protocol ? existing.port : defaultPort(protocol);
  const portRaw = await vscode.window.showInputBox({
    title: `${steps} — Port`,
    prompt: 'Port',
    value: String(portDefault),
    ignoreFocusOut: true,
    validateInput: (v) => (/^\d+$/.test(v.trim()) && +v > 0 && +v < 65536 ? undefined : 'Enter a valid port number')
  });
  if (portRaw === undefined) {
    return undefined;
  }

  const username = await vscode.window.showInputBox({
    title: `${steps} — Username`,
    prompt: 'Login username',
    value: existing?.username ?? '',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Username is required')
  });
  if (username === undefined) {
    return undefined;
  }

  let auth: AuthMethod = 'password';
  let privateKeyPath: string | undefined;
  if (protocol === 'sftp') {
    const authPick = await vscode.window.showQuickPick(
      [
        { label: 'Password', method: 'password' as AuthMethod },
        { label: 'Private key file', method: 'privateKey' as AuthMethod }
      ],
      { title: `${steps} — Authentication`, ignoreFocusOut: true }
    );
    if (!authPick) {
      return undefined;
    }
    auth = authPick.method;
  }

  if (auth === 'privateKey') {
    const keyPath = await vscode.window.showInputBox({
      title: 'Private key path',
      prompt: 'Local path to the private key file (e.g. C:\\Users\\me\\.ssh\\id_rsa)',
      value: existing?.privateKeyPath ?? '',
      ignoreFocusOut: true,
      validateInput: (v) => {
        if (!v.trim()) {
          return 'Path is required';
        }
        return fs.existsSync(v.trim()) ? undefined : 'File does not exist';
      }
    });
    if (keyPath === undefined) {
      return undefined;
    }
    privateKeyPath = keyPath.trim();
    const passphrase = await vscode.window.showInputBox({
      title: 'Key passphrase',
      prompt: 'Passphrase for the key (leave empty if the key is not encrypted)',
      password: true,
      ignoreFocusOut: true
    });
    if (passphrase === undefined) {
      return undefined;
    }
    if (passphrase) {
      await secrets.set(id, 'passphrase', passphrase);
    } else {
      await secrets.delete(id, 'passphrase');
    }
  } else {
    const existingPassword = editing ? await secrets.get(id, 'password') : undefined;
    const password = await vscode.window.showInputBox({
      title: 'Password',
      prompt: existingPassword
        ? 'New password (leave empty to keep the stored one)'
        : 'Password (stored in the OS keychain, never in .rcc/config.json)',
      password: true,
      ignoreFocusOut: true
    });
    if (password === undefined) {
      return undefined;
    }
    if (password) {
      await secrets.set(id, 'password', password);
    }
  }

  const remoteRootRaw = await vscode.window.showInputBox({
    title: `${steps} — Remote root`,
    prompt: 'Absolute path used as the root of this folder (typical shared hosting: /public_html)',
    value: existing?.remoteRoot ?? '/',
    ignoreFocusOut: true
  });
  if (remoteRootRaw === undefined) {
    return undefined;
  }

  const readOnlyPick = await vscode.window.showQuickPick(
    [
      { label: 'Read/write', description: 'Normal editing with the safety pipeline', readOnly: false },
      { label: 'Read-only', description: 'Browse and diff only — all writes are blocked', readOnly: true }
    ],
    { title: `${steps} — Access mode`, ignoreFocusOut: true }
  );
  if (!readOnlyPick) {
    return undefined;
  }

  const profile: ServerProfile = {
    id,
    name: name.trim(),
    protocol,
    host: host.trim(),
    port: parseInt(portRaw.trim(), 10),
    username: username.trim(),
    auth,
    privateKeyPath,
    remoteRoot: normalizeRemotePath(remoteRootRaw),
    readOnly: readOnlyPick.readOnly,
    confirmOnSave: existing?.confirmOnSave,
    backupOnSave: existing?.backupOnSave,
    ftpSecureRejectUnauthorized: existing?.ftpSecureRejectUnauthorized,
    createdAt: existing?.createdAt ?? Date.now(),
    updatedAt: Date.now()
  };

  const config = await testAndRefine(configFromProfile(profile, existing), secrets, logger);
  return config ? { config } : undefined;
}

async function pickLegacyProfile(
  legacy: ServerProfile[],
  folder: vscode.WorkspaceFolder
): Promise<ServerProfile | 'new' | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      ...legacy.map((p) => ({
        label: `$(history) ${p.name}`,
        description: `${protocolLabel(p.protocol)} · ${p.username}@${p.host}`,
        detail: 'From an earlier version — keeps its stored password and backups',
        profile: p as ServerProfile | 'new'
      })),
      { label: '$(add) Set up a new server', description: '', detail: '', profile: 'new' as ServerProfile | 'new' }
    ],
    {
      title: `Set Up Remote — "${folder.name}"`,
      placeHolder: 'Reuse a server from an earlier version, or set up a new one',
      ignoreFocusOut: true
    }
  );
  return pick?.profile;
}

/**
 * Offer a connection test, and on success let the user adopt a discovered
 * WordPress root. Returns the (possibly adjusted) config, or undefined if the
 * user backed out after a failure.
 */
async function testAndRefine(
  config: RemoteConfig,
  secrets: ProfileSecrets,
  logger: Logger
): Promise<RemoteConfig | undefined> {
  const testPick = await vscode.window.showQuickPick(
    [
      { label: '$(plug) Test connection now', test: true },
      { label: 'Save without testing', test: false }
    ],
    { title: 'Test connection?', ignoreFocusOut: true }
  );
  if (!testPick?.test) {
    return config;
  }

  const creds = await buildWizardCredentials(config, secrets);
  if (!creds) {
    return config;
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Testing connection to ${config.host}...` },
    () => testProfileConnection(config, creds, logger)
  );

  if (!result.ok) {
    // A shared host presents its own certificate, not the customer's domain.
    // Offer the host that certificate is valid for rather than a bare failure.
    const altNames = parseCertMismatch(String(result.error));
    if (altNames) {
      const preferred = altNames[altNames.length - 1];
      const useHost = `Use ${preferred}`;
      const answer = await vscode.window.showWarningMessage(
        `${config.host} does not match the server's TLS certificate.`,
        {
          modal: true,
          detail: [
            `The certificate is valid for: ${altNames.join(', ')}.`,
            '',
            `"${useHost}" keeps encryption and verification on and reaches the same account.`,
            '"Skip certificate check" keeps your host name but can no longer detect a man-in-the-middle.'
          ].join('\n')
        },
        useHost,
        'Skip certificate check'
      );
      if (answer === useHost) {
        return { ...config, host: preferred };
      }
      if (answer === 'Skip certificate check') {
        return { ...config, ftpSecureRejectUnauthorized: false };
      }
      return undefined;
    }
    const notes = isAuthFailure(String(result.error))
      ? authFailureAdvice({ protocol: config.protocol, username: config.username, auth: config.auth })
      : [];
    const proceed = await vscode.window.showWarningMessage(
      `Connection test failed: ${result.error}`,
      { modal: true, detail: notes.join(`${DIALOG_GAP}`) },
      'Save Anyway'
    );
    return proceed === 'Save Anyway' ? config : undefined;
  }

  let message = `Connected to ${config.host} successfully.`;
  if (normalizeRemotePath(config.remoteRoot) === '/' && result.rootEntries) {
    const candidate = suggestRootCandidates(result.rootEntries)[0];
    if (candidate) {
      const useIt = await vscode.window.showInformationMessage(
        `${message} Found "/${candidate}" on the server — use it as the remote root?`,
        'Use It',
        'Keep /'
      );
      if (useIt === 'Use It') {
        return { ...config, remoteRoot: joinRemote('/', candidate) };
      }
      message = '';
    }
  }
  if (message) {
    void vscode.window.showInformationMessage(message);
  }
  return config;
}

async function buildWizardCredentials(
  config: RemoteConfig,
  secrets: ProfileSecrets
): Promise<RemoteCredentials | undefined> {
  if (config.auth === 'privateKey') {
    try {
      const privateKey = fs.readFileSync(config.privateKeyPath as string);
      const passphrase = await secrets.get(config.id, 'passphrase');
      return { privateKey, passphrase: passphrase ?? undefined };
    } catch (err) {
      void vscode.window.showErrorMessage(`Cannot read private key: ${String(err)}`);
      return undefined;
    }
  }
  let password = await secrets.get(config.id, 'password');
  if (password === undefined) {
    password = await vscode.window.showInputBox({
      prompt: `Password for ${config.username}@${config.host}`,
      password: true,
      ignoreFocusOut: true
    });
    if (password === undefined) {
      return undefined;
    }
    await secrets.set(config.id, 'password', password);
  }
  return { password };
}
