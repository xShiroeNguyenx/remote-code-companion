const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

const UNIX_RE = /^(\w{3})\s+(\d{1,2})\s+(?:(\d{4})|(\d{1,2}):(\d{2}))$/;
const DOS_RE = /^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i;

/**
 * Best-effort parse of a raw LIST date ("Jan  3 12:30", "Jan  3 2025",
 * "04-27-26 09:09PM"). The server's timezone is unknown, so the result is
 * advisory only — conflict detection treats it with minute-level tolerance.
 */
export function parseRawListDate(raw: string | undefined, now: Date = new Date()): number | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim().replace(/\s+/g, ' ');

  const unix = UNIX_RE.exec(trimmed);
  if (unix) {
    const month = MONTHS[unix[1].toLowerCase()];
    if (month === undefined) {
      return undefined;
    }
    const day = parseInt(unix[2], 10);
    if (unix[3]) {
      return new Date(parseInt(unix[3], 10), month, day).getTime();
    }
    const hours = parseInt(unix[4], 10);
    const minutes = parseInt(unix[5], 10);
    let candidate = new Date(now.getFullYear(), month, day, hours, minutes);
    // LIST omits the year for recent files; a "future" date means last year.
    if (candidate.getTime() > now.getTime() + 2 * 24 * 3600 * 1000) {
      candidate = new Date(now.getFullYear() - 1, month, day, hours, minutes);
    }
    return candidate.getTime();
  }

  const dos = DOS_RE.exec(trimmed);
  if (dos) {
    const month = parseInt(dos[1], 10) - 1;
    const day = parseInt(dos[2], 10);
    let year = parseInt(dos[3], 10);
    if (year < 100) {
      year += year >= 70 ? 1900 : 2000;
    }
    let hours = parseInt(dos[4], 10);
    const minutes = parseInt(dos[5], 10);
    const ampm = dos[6]?.toUpperCase();
    if (ampm === 'PM' && hours < 12) {
      hours += 12;
    } else if (ampm === 'AM' && hours === 12) {
      hours = 0;
    }
    return new Date(year, month, day, hours, minutes).getTime();
  }

  return undefined;
}
