import * as vscode from 'vscode';
import { Logger } from '../core/logger';
import {
  authFailureAdvice,
  isAuthFailure,
  isPathNotFound,
  parseCertMismatch,
  remapRoots,
  suggestRemoteRoot
} from '../core/connect-advice';
import { RemoteConfigStore } from './remote-config-store';
import { RemoteConfig } from './types';

/** Newline as a value. */
const NEWLINE = `
`;

export interface CertFixDeps {
  store: RemoteConfigStore;
  logger: Logger;
  /** Drops the live connection so the next one uses the new settings. */
  onConfigSaved(profileId: string): Promise<void>;
}

/**
 * Offer the two real options. Using the certificate's own host name keeps
 * verification intact and is therefore the first choice; turning verification off
 * is the fallback, and is labelled as what it is.
 */
export async function offerCertFix(config: RemoteConfig, altNames: string[], deps: CertFixDeps): Promise<boolean> {
  const preferred = altNames[altNames.length - 1];
  const useHost = `Connect as ${preferred}`;
  const trustAnyway = 'Skip certificate check';

  const answer = await vscode.window.showWarningMessage(
    `${config.host} does not match the server's TLS certificate.`,
    {
      modal: true,
      detail: [
        `Shared hosts usually present the certificate of the machine itself, not of your domain.`,
        `This one is valid for: ${altNames.join(', ')}.`,
        '',
        `"${useHost}" changes the host in this folder's config. Encryption and verification both stay on — this is the safe option, and the connection reaches the same account.`,
        '',
        `"${trustAnyway}" keeps ${config.host} but stops checking the certificate. Traffic is still encrypted, but a man-in-the-middle could no longer be detected.`
      ].join('\n')
    },
    useHost,
    trustAnyway
  );

  if (answer === useHost) {
    await applyFix(config, { host: preferred }, deps);
    void vscode.window.showInformationMessage(`Host changed to ${preferred}. Try connecting again.`);
    return true;
  }
  if (answer === trustAnyway) {
    await applyFix(config, { ftpSecureRejectUnauthorized: false }, deps);
    void vscode.window.showInformationMessage(
      `Certificate verification disabled for "${config.name}". Try connecting again.`
    );
    return true;
  }
  return false;
}

async function applyFix(config: RemoteConfig, patch: Partial<RemoteConfig>, deps: CertFixDeps): Promise<void> {
  const folder = deps.store.folderFor(config.id);
  if (!folder) {
    return;
  }
  await deps.store.write(folder, { ...config, ...patch, updatedAt: Date.now() });
  await deps.onConfigSaved(config.id);
  deps.logger.info(`[${config.name}] applied TLS fix: ${JSON.stringify(patch)}`);
}

/**
 * Wraps a failed connection attempt: if it failed on the certificate name, offer
 * the fix; otherwise report the error as-is.
 */
export async function reportConnectionFailure(
  config: RemoteConfig,
  error: string,
  deps: CertFixDeps
): Promise<void> {
  const altNames = parseCertMismatch(error);
  if (altNames && (await offerCertFix(config, altNames, deps))) {
    return;
  }

  // Rejected credentials on cPanel almost always come down to the wrong kind of
  // account name, which the raw message never says.
  // Switching protocol changes what the same directory is called, so a missing
  // root is usually the old protocol's path rather than a missing directory.
  if (isPathNotFound(error)) {
    const suggested = suggestRemoteRoot(config);
    if (suggested) {
      const useIt = `Use ${suggested}`;
      const answer = await vscode.window.showWarningMessage(
        `${config.remoteRoot} does not exist on ${config.host}.`,
        {
          modal: true,
          detail: [
            error,
            config.protocol === 'sftp'
              ? 'An FTP sub-account is locked into its own directory, so paths start at /public_html. SSH logs in as the real account, where the same directory is under the home folder.'
              : 'FTP accounts are usually locked into their own directory, so the /home/<account> prefix has to go.',
            `Suggested remote root: ${suggested}`,
            'Synced subtrees will be re-pointed at the new root, and the sync baseline resets — pull again afterwards.'
          ].join(`${NEWLINE}${NEWLINE}`)
        },
        useIt
      );
      if (answer === useIt) {
        await applyFix(
          config,
          { remoteRoot: suggested, roots: remapRoots(config.roots, config.remoteRoot, suggested) },
          deps
        );
        void vscode.window.showInformationMessage(`Remote root changed to ${suggested}. Try again.`);
        return;
      }
    }
  }

  if (isAuthFailure(error)) {
    const notes = authFailureAdvice({
      protocol: config.protocol,
      username: config.username,
      auth: config.auth
    });
    void vscode.window.showWarningMessage(`The server rejected the credentials for ${config.username}.`, {
      modal: true,
      detail: [error, ...notes].join(`${NEWLINE}${NEWLINE}`)
    });
    return;
  }

  void vscode.window.showErrorMessage(`Connection failed: ${error}`);
}
