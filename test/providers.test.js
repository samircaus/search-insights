import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleReport, mapGoogleError, googleClient } from '../worker/providers/google.js';
import {
  bingReport, bingWindows, detectGranularity, parseBingRows, bingClient,
} from '../worker/providers/bing.js';

const URL_ = 'https://edgepatterns.dev/martech/fpid';

function fakeGoogle({ latest = '2026-11-05', totals, queries }) {
  const calls = [];
  return {
    calls,
    async query(property, req) {
      calls.push({ property, req });
      if (req.dimensions?.[0] === 'date') {
        return { rows: latest ? [{ keys: ['2026-11-04'] }, { keys: [latest] }] : [] };
      }
      const which = req.startDate === '2026-10-09' ? 'cur' : 'prev';
      if (!req.dimensions) return { rows: totals[which] ? [totals[which]] : [] };
      return { rows: (queries[which] || []).slice(req.startRow, req.startRow + req.rowLimit) };
    },
  };
}

test('google: requests use finalized data, page filter, and separate totals', async () => {
  const g = fakeGoogle({
    totals: { cur: { clicks: 10, impressions: 500, position: 7 }, prev: { clicks: 8, impressions: 400, position: 8 } },
    queries: {
      cur: [{ keys: ['a'], clicks: 4, impressions: 100, position: 3 }],
      prev: [{ keys: ['a'], clicks: 2, impressions: 80, position: 4 }],
    },
  });
  const r = await googleReport({
    client: g, property: 'sc-domain:edgepatterns.dev', url: URL_, now: new Date('2026-11-09T12:00:00Z'),
  });
  assert.ok(g.calls.every((c) => c.req.dataState === 'final' && c.req.type === 'web'));
  const pageCalls = g.calls.filter((c) => c.req.dimensionFilterGroups);
  assert.equal(pageCalls.length, 4);
  pageCalls.forEach((c) => assert.deepEqual(c.req.dimensionFilterGroups[0].filters[0], { dimension: 'page', operator: 'equals', expression: URL_ }));
  assert.deepEqual(r.periods.current, { start: '2026-10-09', end: '2026-11-05' });
  assert.deepEqual(r.periods.previous, { start: '2026-09-11', end: '2026-10-08' });
  assert.equal(r.summary.current.clicks, 10); // from totals, not summed rows (4)
  assert.equal(r.summary.source, 'page-totals');
  assert.equal(r.queries[0].previousStatus, 'present');
  assert.equal(r.freshness.latestDate, '2026-11-05');
  assert.ok(r.warnings.some((w) => w.code === 'partial-query-coverage'));
});

test('google: empty previous period is not comparable; empty page is no data', async () => {
  const g = fakeGoogle({ totals: { cur: null, prev: null }, queries: {} });
  const r = await googleReport({ client: g, property: 'sc-domain:edgepatterns.dev', url: URL_, now: new Date('2026-11-09T12:00:00Z') });
  assert.equal(r.hasData, false);
  assert.equal(r.comparison.available, false);
  assert.equal(r.summary.current.ctr, null);
});

test('google: paginates with startRow and flags truncation', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ keys: [`q${i}`], clicks: 30 - i, impressions: 100, position: 5 }));
  const g = fakeGoogle({ totals: { cur: { clicks: 100, impressions: 3000 }, prev: null }, queries: { cur: many, prev: [] } });
  const r = await googleReport({
    client: g, property: 'sc-domain:edgepatterns.dev', url: URL_, maxRows: 10, now: new Date('2026-11-09T12:00:00Z'),
  });
  assert.equal(r.queries.length, 10);
  assert.equal(r.limits.currentRowsTruncated, true);
});

test('google: rejects URLs outside the property', async () => {
  const g = fakeGoogle({ totals: {}, queries: {} });
  await assert.rejects(googleReport({ client: g, property: 'sc-domain:edgepatterns.dev', url: 'https://other.dev/x' }), { code: 'URL_NOT_ALLOWED' });
});

test('google: no recent finalized data is reported honestly', async () => {
  const g = fakeGoogle({ latest: null, totals: {}, queries: {} });
  const r = await googleReport({ client: g, property: 'sc-domain:edgepatterns.dev', url: URL_, now: new Date('2026-11-09T12:00:00Z') });
  assert.equal(r.comparison.available, false);
  assert.ok(r.warnings.some((w) => w.code === 'no-recent-data'));
});

test('google: error mapping', () => {
  assert.equal(mapGoogleError(401, {}).code, 'REAUTH_REQUIRED');
  assert.equal(mapGoogleError(403, { error: { errors: [{ reason: 'forbidden' }] } }).code, 'PROPERTY_ACCESS_DENIED');
  assert.equal(mapGoogleError(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }).code, 'RATE_LIMITED');
  assert.equal(mapGoogleError(429, {}).code, 'RATE_LIMITED');
  assert.equal(mapGoogleError(503, {}).code, 'PROVIDER_UNAVAILABLE');
});

test('google client encodes the property and sends a bearer token', async () => {
  let seen;
  const client = googleClient({
    accessToken: 'ya29.test',
    fetchImpl: async (url, init) => { seen = { url, init }; return new Response('{"rows":[]}', { status: 200 }); },
  });
  await client.query('sc-domain:edgepatterns.dev', { startDate: '2026-01-01', endDate: '2026-01-02' });
  assert.equal(seen.url, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aedgepatterns.dev/searchAnalytics/query');
  assert.equal(seen.init.headers.authorization, 'Bearer ya29.test');
});

// --- Bing ---------------------------------------------------------------

const msDate = (ymd) => `/Date(${Date.parse(`${ymd}T07:00:00Z`)}-0700)/`;
const qs = (query, date, clicks, impressions, pos) => ({
  __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', Query: query, Date: msDate(date), Clicks: clicks, Impressions: impressions, AvgImpressionPosition: pos, AvgClickPosition: pos,
});

test('bing: parses Microsoft dates and drops invalid positions', () => {
  const [r] = parseBingRows([{ ...qs('a', '2026-11-02', 1, 10, -1) }]);
  assert.equal(r.date, '2026-11-02');
  assert.equal(r.position, null);
});

test('bing: weekly windows and comparability', () => {
  const dates = ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02'];
  assert.equal(detectGranularity(dates), 'week');
  const w = bingWindows(dates, 28);
  assert.deepEqual(w.current.rowDates, ['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02']);
  assert.deepEqual(w.previous.rowDates, ['2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05']);
  assert.equal(w.comparable, true);
  const partial = bingWindows(dates.slice(3), 28);
  assert.equal(partial.comparable, false);
  assert.match(partial.reason, /not comparable/);
});

function fakeBing(queryRows, pageRows = []) {
  return {
    getPageQueryStats: async () => queryRows,
    getPageStats: async () => pageRows,
  };
}

test('bing: aggregates query rows per window with weighted position; derived totals are warned', async () => {
  const rows = [
    qs('fpid', '2026-10-26', 3, 100, 2), qs('fpid', '2026-11-02', 1, 300, 6),
    qs('fpid', '2026-09-28', 2, 50, 3), qs('fpid', '2026-10-05', 2, 50, 3),
    qs('ecid', '2026-11-02', 0, 10, 9),
  ];
  const r = await bingReport({ client: fakeBing(rows), siteUrl: 'https://edgepatterns.dev/', url: URL_ });
  const fpid = r.queries.find((q) => q.query === 'fpid');
  assert.equal(fpid.current.clicks, 4);
  assert.equal(fpid.current.impressions, 400);
  assert.equal(fpid.current.position, 5); // (2*100 + 6*300) / 400
  assert.equal(r.summary.source, 'derived-from-query-rows');
  assert.ok(r.warnings.some((w) => w.code === 'derived-totals'));
  assert.equal(r.provider, 'bing');
});

test('bing: uses GetPageStats totals when the page is listed', async () => {
  const rows = [qs('fpid', '2026-11-02', 1, 10, 4), qs('fpid', '2026-10-05', 1, 10, 4)];
  const pages = [qs(URL_, '2026-11-02', 20, 900, 5), qs('https://edgepatterns.dev/other', '2026-11-02', 99, 9999, 1), qs(URL_, '2026-10-05', 10, 800, 6)];
  const r = await bingReport({ client: fakeBing(rows, pages), siteUrl: 'https://edgepatterns.dev/', url: URL_ });
  assert.equal(r.summary.source, 'page-totals');
  assert.equal(r.summary.current.clicks, 20);
});

test('bing: no data and URL restrictions', async () => {
  const r = await bingReport({ client: fakeBing([]), siteUrl: 'https://edgepatterns.dev/', url: URL_ });
  assert.equal(r.hasData, false);
  await assert.rejects(bingReport({ client: fakeBing([]), siteUrl: 'https://edgepatterns.dev/', url: 'https://other.dev/' }), { code: 'URL_NOT_ALLOWED' });
});

test('bing client: api key in query for apiKey mode, bearer for OAuth; errors mapped', async () => {
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return new Response('{"d":[]}', { status: 200 }); };
  await bingClient({ apiKey: 'k123', fetchImpl: ok }).getPageQueryStats('https://edgepatterns.dev/', URL_);
  assert.match(seen.url, /^https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/GetPageQueryStats\?/);
  assert.match(seen.url, /apikey=k123/);
  await bingClient({ accessToken: 'tok', fetchImpl: ok }).getPageStats('https://edgepatterns.dev/');
  assert.equal(seen.init.headers.authorization, 'Bearer tok');
  assert.doesNotMatch(seen.url, /apikey/);
  const bad = async () => new Response('{"ErrorCode":3,"Message":"InvalidApiKey"}', { status: 400 });
  await assert.rejects(bingClient({ apiKey: 'x', fetchImpl: bad }).getUserSites(), { code: 'REAUTH_REQUIRED' });
  const throttled = async () => new Response('{"ErrorCode":14,"Message":"ThrottleUser"}', { status: 400 });
  await assert.rejects(bingClient({ apiKey: 'x', fetchImpl: throttled }).getUserSites(), { code: 'RATE_LIMITED' });
});
