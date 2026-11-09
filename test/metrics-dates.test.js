import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ctr, relativeChange, ppChange, positionChange, weightedPosition, joinQueryRows, fmtRelChange, fmtPp,
} from '../web/core/metrics.js';
import {
  comparisonWindows, addDays, daysInclusive, parseMsJsonDate, todayInTimeZone, isYmd,
} from '../web/core/dates.js';

test('CTR uses clicks/impressions and handles zero denominator as missing', () => {
  assert.equal(ctr(5, 100), 0.05);
  assert.equal(ctr(0, 0), null);
  assert.equal(ctr(null, 10), null);
  assert.equal(ctr(0, 10), 0);
});

test('CTR change is in percentage points', () => {
  assert.ok(Math.abs(ppChange(0.05, 0.03) - 2) < 1e-9);
  assert.equal(fmtPp(ppChange(0.05, 0.03)), '+2.0 pp');
  assert.equal(fmtPp(ppChange(0.02, 0.03)), '−1.0 pp');
  assert.equal(ppChange(null, 0.03), null);
  assert.equal(fmtPp(null), 'not comparable');
});

test('relative change from zero is "new", both zero is no change, missing is not comparable', () => {
  assert.deepEqual(relativeChange(10, 0), { kind: 'new' });
  assert.deepEqual(relativeChange(0, 0), { kind: 'unchanged-zero' });
  assert.deepEqual(relativeChange(10, null), { kind: 'not-comparable' });
  assert.equal(relativeChange(75, 100).value, -0.25);
  assert.equal(fmtRelChange({ kind: 'new' }), 'new (was 0)');
  assert.equal(fmtRelChange(relativeChange(75, 100)), '−25%');
});

test('lower position is an improvement', () => {
  assert.equal(positionChange(4, 6).direction, 'improved');
  assert.equal(positionChange(8, 6).direction, 'declined');
  assert.equal(positionChange(6.01, 6).direction, 'unchanged');
  assert.equal(positionChange(null, 6), null);
});

test('average position is impression-weighted, not an average of averages', () => {
  const rows = [
    { position: 1, impressions: 900 },
    { position: 10, impressions: 100 },
  ];
  assert.equal(weightedPosition(rows), 1.9); // simple mean would be 5.5
  assert.equal(weightedPosition([{ position: 3, impressions: 0 }]), null);
});

test('query absent from previous returned rows is not a zero', () => {
  const { rows, onlyInPrevious } = joinQueryRows(
    [{ query: 'a', clicks: 5, impressions: 50, position: 3 }, { query: 'b', clicks: 1, impressions: 20, position: 9 }],
    [{ query: 'a', clicks: 3, impressions: 40, position: 4 }, { query: 'c', clicks: 2, impressions: 10, position: 7 }],
  );
  const b = rows.find((r) => r.query === 'b');
  assert.equal(b.previous, null);
  assert.equal(b.previousStatus, 'not-in-returned-rows');
  assert.deepEqual(b.change.clicks, { kind: 'not-comparable' });
  assert.equal(rows.find((r) => r.query === 'a').previousStatus, 'present');
  assert.equal(onlyInPrevious[0].query, 'c');
  assert.equal(onlyInPrevious[0].current, null);
});

test('no previous period at all marks rows not comparable', () => {
  const { rows } = joinQueryRows([{ query: 'a', clicks: 1, impressions: 2, position: 1 }], null);
  assert.equal(rows[0].previousStatus, 'not-comparable');
});

test('28-day comparison windows are adjacent, equal length and inclusive', () => {
  const w = comparisonWindows('2026-11-05', 28);
  assert.deepEqual(w.current, { start: '2026-10-09', end: '2026-11-05' });
  assert.deepEqual(w.previous, { start: '2026-09-11', end: '2026-10-08' });
  assert.equal(daysInclusive(w.current.start, w.current.end), 28);
  assert.equal(daysInclusive(w.previous.start, w.previous.end), 28);
  assert.equal(addDays(w.previous.end, 1), w.current.start);
});

test('windows across DST change and leap day stay calendar-exact', () => {
  // US DST ends 2026-11-01; arithmetic is on calendar dates, so no drift.
  const w = comparisonWindows('2026-11-02', 7);
  assert.deepEqual(w.current, { start: '2026-10-27', end: '2026-11-02' });
  const leap = comparisonWindows('2028-03-01', 2);
  assert.deepEqual(leap.current, { start: '2028-02-29', end: '2028-03-01' });
});

test('today in Pacific Time differs from UTC late in the UTC day', () => {
  const now = new Date('2026-11-09T03:00:00Z'); // 19:00 PT on Nov 8
  assert.equal(todayInTimeZone('America/Los_Angeles', now), '2026-11-08');
  assert.equal(todayInTimeZone('UTC', now), '2026-11-09');
});

test('Microsoft JSON dates parse to the calendar date of their offset', () => {
  assert.equal(parseMsJsonDate('/Date(1316156400000-0700)/'), '2011-09-16');
  assert.equal(parseMsJsonDate('/Date(1316156400000)/'), '2011-09-16');
  assert.equal(parseMsJsonDate('garbage'), null);
});

test('isYmd rejects impossible dates', () => {
  assert.ok(isYmd('2026-02-28'));
  assert.ok(!isYmd('2026-02-30'));
  assert.ok(!isYmd('26-02-01'));
});
