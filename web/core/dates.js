/**
 * Date helpers working on calendar dates (YYYY-MM-DD strings).
 *
 * Google Search Console dates are calendar days in Pacific Time
 * (America/Los_Angeles). We never convert those to instants: arithmetic is
 * done on the calendar date itself (via UTC midnight) so DST changes cannot
 * shift a boundary.
 */

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isYmd(s) {
  if (typeof s !== 'string' || !YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function addDays(ymd, n) {
  if (!isYmd(ymd)) throw new TypeError(`invalid date: ${ymd}`);
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Inclusive number of days from start to end. */
export function daysInclusive(start, end) {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * Two adjacent windows of equal length ending on `latestDate` (inclusive).
 * current  = [latest - (days-1), latest]
 * previous = [current.start - days, current.start - 1]
 */
export function comparisonWindows(latestDate, days = 28) {
  if (!Number.isInteger(days) || days < 1 || days > 240) throw new RangeError('days out of range');
  const currentEnd = latestDate;
  const currentStart = addDays(currentEnd, -(days - 1));
  const previousEnd = addDays(currentStart, -1);
  const previousStart = addDays(previousEnd, -(days - 1));
  return {
    days,
    current: { start: currentStart, end: currentEnd },
    previous: { start: previousStart, end: previousEnd },
  };
}

/** Today's calendar date in a given IANA time zone. */
export function todayInTimeZone(timeZone = 'America/Los_Angeles', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Parse a Microsoft JSON date: "/Date(1316156400000-0700)/".
 * Returns the calendar date in the offset that the value carries.
 */
export function parseMsJsonDate(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/\/Date\((-?\d+)([+-]\d{4})?\)\//);
  if (!m) return null;
  const ms = Number(m[1]);
  let offsetMin = 0;
  if (m[2]) {
    const sign = m[2][0] === '-' ? -1 : 1;
    offsetMin = sign * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3, 5)));
  }
  const d = new Date(ms + offsetMin * 60000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function fmtDate(ymd) {
  if (!isYmd(ymd)) return '—';
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  });
}

export function fmtRange(range) {
  if (!range) return '—';
  return `${fmtDate(range.start)} – ${fmtDate(range.end)}`;
}

/** "Oct 9 – Nov 5, 2026"; the year is dropped from the start (or entirely with omitYear) when both ends share it. */
export function fmtRangeShort(range, { omitYear = false } = {}) {
  if (!range || !isYmd(range.start) || !isYmd(range.end)) return fmtRange(range);
  const md = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const sameYear = range.start.slice(0, 4) === range.end.slice(0, 4);
  if (!sameYear) return fmtRange(range);
  return `${md(range.start)} – ${md(range.end)}${omitYear ? '' : `, ${range.end.slice(0, 4)}`}`;
}
