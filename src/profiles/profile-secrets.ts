import * as vscode from 'vscode';

export type SecretKind = 'password' | 'passphrase';

/**
 * Passwords and key passphrases live only in vscode SecretStorage
 * (the OS keychain) — never in settings.json or globalState.
 */
export class ProfileSecrets {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  private key(profileId: string, kind: SecretKind): string {
    return `remoteCodeCompanion.secret.${profileId}.${kind}`;
  }

  get(profileId: string, kind: SecretKind): Thenable<string | undefined> {
    return this.secrets.get(this.key(profileId, kind));
  }

  async set(profileId: string, kind: SecretKind, value: string): Promise<void> {
    await this.secrets.store(this.key(profileId, kind), value);
  }

  async delete(profileId: string, kind: SecretKind): Promise<void> {
    await this.secrets.delete(this.key(profileId, kind));
  }

  async deleteAll(profileId: string): Promise<void> {
    await this.delete(profileId, 'password');
    await this.delete(profileId, 'passphrase');
  }
}
