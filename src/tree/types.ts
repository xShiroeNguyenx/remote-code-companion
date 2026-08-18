import { RemoteFileType } from '../connection/types';

export type RemoteNodeKind = 'profile' | 'dir' | 'file';

export interface RemoteNode {
  kind: RemoteNodeKind;
  profileId: string;
  /** Absolute remote path. For profile nodes this is the profile's remoteRoot. */
  path: string;
  name: string;
  fileType?: RemoteFileType;
}

export const CONTEXT_PROFILE_CONNECTED = 'rcc.profile.connected';
export const CONTEXT_PROFILE_DISCONNECTED = 'rcc.profile.disconnected';
export const CONTEXT_DIR = 'rcc.dir';
export const CONTEXT_FILE = 'rcc.file';
