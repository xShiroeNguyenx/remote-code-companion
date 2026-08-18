import { MtimeSource } from '../connection/types';

export interface ConflictSide {
  mtimeMs?: number;
  size: number;
  mtimeSource: MtimeSource;
}

export interface ConflictVerdict {
  conflict: boolean;
  /** True when the server gave us too little metadata for a reliable check. */
  degraded: boolean;
  reason: string;
}

/** Second-precision sources can disagree by rounding; allow just under 2s. */
const PRECISE_TOLERANCE_MS = 1999;
/** LIST dates have minute granularity and an unknown timezone offset applies equally to both sides. */
const LISTING_TOLERANCE_MS = 120000;

function precision(side: ConflictSide): 0 | 1 | 2 {
  if (side.mtimeMs === undefined) {
    return 0;
  }
  if (side.mtimeSource === 'sftp' || side.mtimeSource === 'mdtm') {
    return 2;
  }
  return side.mtimeSource === 'listing' ? 1 : 0;
}

/**
 * Did the file change on the server since we captured the baseline (at open)?
 * Confidence adapts to the worst mtime source involved; size is always the
 * primary signal because it never lies.
 */
export function detectConflict(baseline: ConflictSide, fresh: ConflictSide): ConflictVerdict {
  const sizeChanged = baseline.size !== fresh.size;
  const level = Math.min(precision(baseline), precision(fresh));

  if (level === 0) {
    return {
      conflict: sizeChanged,
      degraded: true,
      reason: sizeChanged
        ? `size changed on server (${baseline.size} → ${fresh.size} bytes)`
        : 'no server mtime available — size-only check passed'
    };
  }

  const delta = Math.abs((baseline.mtimeMs as number) - (fresh.mtimeMs as number));
  const tolerance = level === 2 ? PRECISE_TOLERANCE_MS : LISTING_TOLERANCE_MS;
  const mtimeChanged = delta > tolerance;

  if (sizeChanged || mtimeChanged) {
    const parts: string[] = [];
    if (sizeChanged) {
      parts.push(`size ${baseline.size} → ${fresh.size} bytes`);
    }
    if (mtimeChanged) {
      parts.push(`modified time moved by ${Math.round(delta / 1000)}s`);
    }
    return { conflict: true, degraded: level === 1, reason: parts.join(', ') };
  }
  return { conflict: false, degraded: level === 1, reason: 'unchanged' };
}
