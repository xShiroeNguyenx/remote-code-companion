/**
 * How big is the change about to be uploaded? Answered from bytes we already
 * hold — the pre-save backup downloads the server copy anyway — so the
 * confirmation can say "+18 −4 lines" instead of only naming a file.
 *
 * Deliberately not a real diff: the number is a sense of scale, and the exact
 * hunks are what "Diff with Server" is for. Common prefix and suffix are
 * trimmed first, which makes the count exact for the usual single-hunk edit;
 * the remaining middle is then compared as a multiset of lines, so a moved
 * block does not read as a rewrite of the whole file.
 */
export interface LineDelta {
  added: number;
  removed: number;
}

/** A NUL byte early in the file: text tools have nothing useful to say about it. */
const BINARY_SNIFF_BYTES = 8000;

export function isProbablyBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

function splitLines(text: string): string[] {
  if (text === '') {
    return []; // an empty file has no lines, rather than one empty one
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // A trailing newline terminates the last line; it does not add an empty one.
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function lineDelta(before: string, after: string): LineDelta {
  const a = splitLines(before);
  const b = splitLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  // What is left is the changed middle. Counting it as a multiset means a line
  // that only moved is not reported as both an addition and a removal.
  const remaining = new Map<string, number>();
  for (let i = start; i < endA; i++) {
    remaining.set(a[i], (remaining.get(a[i]) ?? 0) + 1);
  }
  let added = 0;
  for (let i = start; i < endB; i++) {
    const left = remaining.get(b[i]) ?? 0;
    if (left > 0) {
      remaining.set(b[i], left - 1);
    } else {
      added++;
    }
  }
  let removed = 0;
  for (const left of remaining.values()) {
    removed += left;
  }
  return { added, removed };
}

/** Undefined when there is nothing to compare against, or the bytes are not text. */
export function changeSummary(server: Uint8Array | undefined, local: Uint8Array): LineDelta | undefined {
  if (!server || isProbablyBinary(server) || isProbablyBinary(local)) {
    return undefined;
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return lineDelta(decoder.decode(server), decoder.decode(local));
}
