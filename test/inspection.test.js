import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInspection, inspectionBriefLines, inspectionChecks } from '../web/core/inspection.js';
import { googleClient, googleInspection } from '../worker/providers/google.js';
import { handle } from '../worker/app.js';
import { memoryStore, secureStore } from '../worker/store.js';
import { tokenKey } from '../worker/oauth.js';
import { buildBrief } from '../web/core/brief.js';
import { buildResult } from '../web/core/normalize.js';
import { comparisonWindows } from '../web/core/dates.js';

const URL_ = 'https://edgepatterns.dev/martech/fpid';
const NOW = Date.parse('2026-11-09T12:00:00Z');
const meta = { url: URL_, property: 'sc-domain:edgepatterns.dev', now: NOW };

test('indexed page with matching canonical', () => {
  const i = normalizeInspection({
    inspectionResultLink: 'https://search.google.com/x',
    indexStatusResult: {
      verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-11-06T22:05:31Z',
      googleCanonical: URL_, userCanonical: URL_, pageFetchState: 'SUCCESSFUL', indexingState: 'INDEXING_ALLOWED', robotsTxtState: 'ALLOWED',
    },
  }, meta);
  assert.equal(i.status, 'indexed');
  assert.equal(i.canonical, 'self');
  assert.equal(i.lastCrawlDays, 2);
  assert.deepEqual(i.findings.map((f) => f.code), ['indexed']);
  assert.deepEqual(inspectionChecks(i), []);
});

test('not indexed: noindex, robots, fetch errors are reported', () => {
  const i = normalizeInspection({
    indexStatusResult: {
      verdict: 'FAIL', coverageState: 'Excluded by ‘noindex’ tag', indexingState: 'BLOCKED_BY_META_TAG',
      robotsTxtState: 'DISALLOWED', pageFetchState: 'SOFT_404',
    },
  }, meta);
  assert.equal(i.status, 'error');
  const codes = i.findings.map((f) => f.code);
  for (const c of ['not-indexed', 'noindex', 'robots-disallowed', 'fetch-soft_404', 'never-crawled']) assert.ok(codes.includes(c), c);
});

test('Google-selected canonical that differs is flagged with the canonical URL', () => {
  const other = 'https://edgepatterns.dev/personalization/personalization-and-optimization';
  const i = normalizeInspection({
    indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Duplicate, Google chose different canonical than user', googleCanonical: other, userCanonical: URL_ },
  }, meta);
  assert.equal(i.canonical, 'other');
  const f = i.findings.find((x) => x.code === 'google-canonical-differs');
  assert.equal(f.canonical, other);
  assert.match(f.message, /usually reports search data under its selected canonical/);
});

test('unknown verdict and missing fields do not crash or overclaim', () => {
  const i = normalizeInspection({}, meta);
  assert.equal(i.status, 'unknown');
  assert.equal(i.canonical, 'unknown');
  assert.ok(!i.findings.some((f) => f.code === 'indexed'));
});

test('rich result errors are summarised', () => {
  const i = normalizeInspection({
    indexStatusResult: { verdict: 'PASS', googleCanonical: URL_ },
    richResultsResult: {
      verdict: 'FAIL',
      detectedItems: [{ richResultType: 'FAQ', items: [{ name: 'q', issues: [{ issueMessage: 'Missing field', severity: 'ERROR' }, { issueMessage: 'x', severity: 'WARNING' }] }] }],
    },
  }, meta);
  assert.deepEqual(i.richResults.types[0], {
    type: 'FAQ', items: 1, errors: 1, warnings: 1, issues: [{ item: 'q', message: 'Missing field', severity: 'ERROR' }, { item: 'q', message: 'x', severity: 'WARNING' }],
  });
  assert.ok(i.findings.some((f) => f.code === 'rich-results-errors'));
});

test('client posts to the URL Inspection endpoint with inspectionUrl and siteUrl', async () => {
  let seen;
  const client = googleClient({
    accessToken: 'ya29.t',
    fetchImpl: async (url, init) => { seen = { url, init }; return Response.json({ inspectionResult: { indexStatusResult: { verdict: 'PASS' } } }); },
  });
  const r = await googleInspection({ client, property: 'sc-domain:edgepatterns.dev', url: URL_, now: NOW });
  assert.equal(seen.url, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { inspectionUrl: URL_, siteUrl: 'sc-domain:edgepatterns.dev', languageCode: 'en-US' });
  assert.equal(r.status, 'indexed');
  await assert.rejects(googleInspection({ client, property: 'sc-domain:edgepatterns.dev', url: 'https://other.dev/x' }), { code: 'URL_NOT_ALLOWED' });
});

test('client maps quota and permission errors', async () => {
  const mk = (status, body) => googleClient({ accessToken: 't', fetchImpl: async () => Response.json(body, { status }) });
  await assert.rejects(mk(429, { error: { status: 'RESOURCE_EXHAUSTED' } }).inspect('sc-domain:x.dev', 'https://x.dev/'), { code: 'RATE_LIMITED' });
  await assert.rejects(mk(403, { error: { status: 'PERMISSION_DENIED', message: 'no access' } }).inspect('sc-domain:x.dev', 'https://x.dev/'), { code: 'PROPERTY_ACCESS_DENIED' });
});

// --- endpoint ------------------------------------------------------------

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const SITE = {
  id: 'edgepatterns', da: { org: 'samircaus', site: 'da-elsie' }, productionOrigin: 'https://edgepatterns.dev',
  google: { properties: ['sc-domain:edgepatterns.dev'] },
};
const ENV = {
  SITES: { sites: [SITE] }, TOKEN_ENCRYPTION_KEY: KEY, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', IMS_CLIENT_IDS: 'darkalley',
};
const IMS = 'eyJhbGciOiJSUzI1NiJ9.eyJ1c2VyX2lkIjoiVTEifQ.signaturesignature';

function fetchStub() {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.includes('validate_token')) return Response.json({ valid: true, token: { user_id: 'U1' } });
    if (u.startsWith('https://admin.da.live/')) return new Response('[]');
    if (u.includes('urlInspection')) return Response.json({ inspectionResult: { indexStatusResult: { verdict: 'PASS', googleCanonical: JSON.parse(init.body).inspectionUrl } } });
    throw new Error(`unexpected ${u}`);
  };
  fn.calls = calls;
  return fn;
}

async function connectedStore() {
  const store = memoryStore();
  const secure = secureStore(store, KEY);
  await secure.put(tokenKey('google', 'U1'), { refreshToken: '1//r' });
  await secure.put('atok:google:U1', { accessToken: 'ya29.a', expiresAt: Date.now() + 3600_000 });
  return store;
}

const req = (qs) => new Request(`https://si.example.workers.dev/api/google/inspect?org=samircaus&site=da-elsie&${qs}`, { headers: { authorization: `Bearer ${IMS}` } });

test('inspect endpoint: returns normalized result and caches it per user/property/URL', async () => {
  const store = await connectedStore();
  const f = fetchStub();
  const q = `url=${encodeURIComponent(URL_)}`;
  const r1 = await (await handle(req(q), { env: ENV, store, fetchImpl: f })).json();
  const r2 = await (await handle(req(q), { env: ENV, store, fetchImpl: f })).json();
  assert.equal(r1.status, 'indexed');
  assert.equal(r1.cache, 'miss');
  assert.equal(r2.cache, 'hit');
  assert.equal(f.calls.filter((c) => c.url.includes('urlInspection')).length, 1);
  assert.ok([...store._map.keys()].some((k) => /^cache:v1:inspect:U1:sc-domain:edgepatterns\.dev:/.test(k)));
});

test('inspect endpoint: refuses other origins and unlisted properties before calling Google', async () => {
  const store = await connectedStore();
  const f = fetchStub();
  const a = await handle(req(`url=${encodeURIComponent('https://evil.example/')}`), { env: ENV, store, fetchImpl: f });
  assert.equal(a.status, 400);
  const b = await handle(req(`url=${encodeURIComponent(URL_)}&property=${encodeURIComponent('sc-domain:other.dev')}`), { env: ENV, store, fetchImpl: f });
  assert.equal(b.status, 400);
  assert.ok(!f.calls.some((c) => c.url.includes('urlInspection')));
});

test('inspect endpoint: not connected', async () => {
  const res = await handle(req(`url=${encodeURIComponent(URL_)}`), { env: ENV, store: memoryStore(), fetchImpl: fetchStub() });
  assert.equal(res.status, 409);
});

test('brief includes index status lines and checks when inspection is provided', () => {
  const result = buildResult({
    provider: 'google', property: 'sc-domain:edgepatterns.dev', requestedUrl: URL_,
    periods: comparisonWindows('2026-11-05', 28), freshness: {}, metrics: { position: { available: true } },
    currentTotals: { clicks: 0, impressions: 0 }, previousTotals: null, summarySource: 'page-totals',
    currentRows: [], previousRows: null, limits: {}, comparison: { available: false, reason: 'n/a' },
  });
  const inspection = normalizeInspection({ indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' } }, meta);
  const b = buildBrief({ result, inspection });
  assert.ok(inspectionBriefLines(inspection).every((l) => b.markdown.includes(l)));
  assert.match(b.markdown, /Index status: Google reports this URL is not indexed/);
});
