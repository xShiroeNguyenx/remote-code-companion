export type BackupReason = 'pre-save' | 'pre-delete' | 'manual';

export interface BackupEntry {
  id: string;
  profileId: string;
  /** Absolute remote path the backup was taken from. */
  remotePath: string;
  /** On-disk file name inside the hashed per-file folder. */
  fileName: string;
  timestamp: number;
  size: number;
  reason: BackupReason;
}

export interface BackupIndex {
  entries: BackupEntry[];
}

export interface BackupRetention {
  maxPerFile: number;
  maxAgeDays: number;
}
