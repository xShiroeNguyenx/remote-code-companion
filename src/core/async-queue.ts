/**
 * Serializes async tasks: each task starts only after the previous one settled.
 * Required because a basic-ftp client rejects overlapping commands, and shared
 * hosts cap concurrent connections — one serialized connection is the safe default.
 */
export class AsyncQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(() => task());
    // The chain link swallows rejections (the caller still gets the original
    // rejecting promise) and decrements immediately on settle, so `idle` is
    // accurate as soon as awaiting callers resume.
    this.tail = result.then(
      () => {
        this.pending--;
      },
      () => {
        this.pending--;
      }
    );
    return result;
  }

  get size(): number {
    return this.pending;
  }

  get idle(): boolean {
    return this.pending === 0;
  }
}
