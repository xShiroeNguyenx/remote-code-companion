import { detectConflict } from '../save/conflict-detector';
import { Classification, SideBase, SideLocal, SideRemote } from './types';

type Verdict = 'same' | 'changed' | 'missing';

function localVerdict(base: SideBase, local: SideLocal): Verdict {
  if (!local.exists) {
    return 'missing';
  }
  return local.sha256 === base.sha256 ? 'same' : 'changed';
}

/**
 * Did the server move away from the baseline? A hash answers definitively; when
 * we only have size/mtime we reuse the save pipeline's granularity-aware check,
 * so both code paths judge FTP timestamps by the same rules.
 */
function remoteVerdict(base: SideBase, remote: SideRemote): { verdict: Verdict; degraded: boolean; detail: string } {
  if (!remote.exists) {
    return { verdict: 'missing', degraded: false, detail: 'gone from the server' };
  }
  if (remote.sha256 !== undefined) {
    return remote.sha256 === base.sha256
      ? { verdict: 'same', degraded: false, detail: 'identical contents' }
      : { verdict: 'changed', degraded: false, detail: 'contents differ from the pulled version' };
  }
  const verdict = detectConflict(
    { size: base.size, mtimeMs: base.mtimeMs, mtimeSource: base.mtimeSource },
    {
      size: remote.size ?? base.size,
      mtimeMs: remote.mtimeMs,
      mtimeSource: remote.mtimeSource ?? 'none'
    }
  );
  return {
    verdict: verdict.conflict ? 'changed' : 'same',
    degraded: verdict.degraded,
    detail: verdict.reason
  };
}

/**
 * The 3-way comparison. Pure by design: every interesting case is a unit test
 * rather than something only reproducible against a live server.
 */
export function classify(base: SideBase | undefined, local: SideLocal, remote: SideRemote): Classification {
  if (!base) {
    // No baseline: the file was never pulled, so it can only be a creation.
    if (!local.exists) {
      return { state: 'bothMissing', reason: 'not present locally and never pulled', degraded: false };
    }
    return remote.exists
      ? {
          state: 'createdBoth',
          reason: 'created locally but a file already exists on the server',
          degraded: false
        }
      : { state: 'created', reason: 'new local file, not on the server yet', degraded: false };
  }

  const localSide = localVerdict(base, local);
  const remoteSide = remoteVerdict(base, remote);

  if (localSide === 'same') {
    switch (remoteSide.verdict) {
      case 'same':
        return { state: 'inSync', reason: 'unchanged on both sides', degraded: remoteSide.degraded };
      case 'changed':
        return {
          state: 'remoteChanged',
          reason: `changed on the server (${remoteSide.detail})`,
          degraded: remoteSide.degraded
        };
      default:
        return { state: 'remoteMissing', reason: 'deleted on the server', degraded: false };
    }
  }

  if (localSide === 'changed') {
    switch (remoteSide.verdict) {
      case 'same':
        return { state: 'localChanged', reason: 'edited locally', degraded: remoteSide.degraded };
      case 'changed':
        return {
          state: 'bothChanged',
          reason: `edited locally and on the server (${remoteSide.detail})`,
          degraded: remoteSide.degraded
        };
      default:
        return {
          state: 'bothChanged',
          reason: 'edited locally but deleted on the server',
          degraded: false
        };
    }
  }

  // Local file is gone.
  switch (remoteSide.verdict) {
    case 'same':
      return { state: 'localMissing', reason: 'deleted locally', degraded: remoteSide.degraded };
    case 'changed':
      return {
        state: 'bothChanged',
        reason: `deleted locally but changed on the server (${remoteSide.detail})`,
        degraded: remoteSide.degraded
      };
    default:
      return { state: 'bothMissing', reason: 'deleted on both sides', degraded: false };
  }
}
