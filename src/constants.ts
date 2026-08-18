export const SCHEME = 'rcc';
export const DIFF_SCHEME = 'rcc-remote';
export const CONFIG_ROOT = 'remoteCodeCompanion';
export const EXTENSION_NAME = 'Remote Code Companion';
export const OUTPUT_CHANNEL_NAME = 'Remote Code Companion';
export const TREE_VIEW_ID = 'remoteCodeCompanion.explorer';
/** Gates the whole view container: no remote declared, nothing in the sidebar. */
export const CONTEXT_HAS_REMOTE = 'rcc.hasRemote';
/** Watched so a hand-edited or newly created declaration is picked up live. */
export const CONFIG_GLOB = '**/.rcc/config.json';
/** Shown once: a local save stays local until pushed. */
export const LOCAL_SAVE_NOTICE_KEY = 'remoteCodeCompanion.localSaveNoticeShown';
