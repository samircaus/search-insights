/**
 * DEMO DATA ONLY. Fictional figures for local development, screenshots and
 * reviewers without credentials. Results pass through the same normalizer as
 * live data. The UI labels every demo view; live failures never fall back here.
 */
import { buildResult } from '../core/normalize.js';
import { normalizeInspection } from '../core/inspection.js';
import { comparisonWindows } from '../core/dates.js';
import { ApiError } from '../api.js';

const LATEST = '2026-11-05';
const ORIGIN = 'https://edgepatterns.dev';

export const DEMO_SITE = {
  id: 'demo',
  label: 'Edge Patterns (demo)',
  da: { org: 'samircaus', site: 'da-elsie' },
  productionOrigin: ORIGIN,
  paths: {},
  google: { properties: ['sc-domain:edgepatterns.dev'] },
  bing: { siteUrl: `${ORIGIN}/` },
  thresholds: null, // defaults
  reportingDays: 28,
};

export const DEMO_PAGES = [
  { path: '/martech/fpid', label: 'FPID guide — rich data with opportunities' },
  { path: '/labs', label: 'Labs — low volume' },
  { path: '/about', label: 'About — no search data' },
  { path: '/personalization/experimentation', label: 'Experimentation — other canonical; Bing fails' },
];

// [query, curClicks, curImpr, curPos, prevClicks|null, prevImpr, prevPos]
const FPID_ROWS = [
  ['fpid adobe', 68, 1450, 3.1, 92, 1610, 2.8],
  ['first party device id', 41, 2210, 6.4, 55, 2380, 5.9],
  ['adobe fpid', 37, 780, 2.2, 44, 820, 2.1],
  ['ecid vs fpid', 22, 640, 4.8, 30, 590, 4.1],
  ['first party id adobe web sdk', 9, 1180, 3.4, 12, 1090, 3.6],
  ['fpid cookie', 18, 520, 5.5, 26, 610, 5.2],
  ['aep web sdk fpid', 14, 410, 7.2, 19, 450, 6.8],
  ['what is fpid', 11, 690, 9.6, 15, 720, 9.1],
  ['server side cookie adobe', 7, 530, 11.4, 9, 480, 12.0],
  ['adobe ecid first party', 6, 470, 12.8, 10, 510, 11.9],
  ['fpid generation', 5, 260, 8.7, 8, 300, 8.1],
  ['cookie keeper adobe', 4, 380, 15.2, null, 0, null],
  ['itp first party cookie adobe', 4, 220, 14.1, 6, 240, 13.5],
  ['fpid vs ecid cookie lifetime', 3, 140, 10.9, null, 0, null],
  ['identitymap fpid', 3, 95, 6.1, 5, 110, 6.0],
  ['first party id', 2, 1020, 18.4, 3, 980, 17.9],
  ['adobe experience platform device id', 1, 160, 21.3, 2, 170, 20.8],
  ['web sdk identity', 0, 210, 24.6, 1, 190, 23.0],
];

function fpidRows(which) {
  return FPID_ROWS
    .filter((r) => which === 'cur' || r[4] !== null)
    .map((r) => (which === 'cur'
      ? { query: r[0], clicks: r[1], impressions: r[2], position: r[3] }
      : { query: r[0], clicks: r[4], impressions: r[5], position: r[6] }));
}

function googleResult(path) {
  const win = comparisonWindows(LATEST, 28);
  const base = {
    provider: 'google',
    property: 'sc-domain:edgepatterns.dev',
    requestedUrl: ORIGIN + path,
    periods: win,
    freshness: {
      latestDate: LATEST, dataState: 'final', timeZone: 'America/Los_Angeles',
      note: `Finalized data through ${LATEST} (Pacific Time). Recent days are excluded until Google finalizes them.`,
    },
    metrics: {
      clicks: { available: true },
      impressions: { available: true },
      ctr: { available: true, definition: 'clicks / impressions' },
      position: { available: true, definition: 'Average topmost position of the page in Google results (lower is better).' },
    },
    summarySource: 'page-totals',
    limits: { rowLimit: 1000, currentRowsTruncated: false, previousRowsTruncated: false },
  };
  if (path === '/martech/fpid' || path === '/personalization/personalization-and-optimization') {
    return buildResult({
      ...base,
      currentTotals: { clicks: 312, impressions: 13140, position: 8.9 },
      previousTotals: { clicks: 401, impressions: 13620, position: 8.4 },
      currentRows: fpidRows('cur'),
      previousRows: fpidRows('prev'),
      comparison: { available: true, kind: 'equal-length-adjacent', days: 28 },
    });
  }
  if (path === '/labs') {
    return buildResult({
      ...base,
      currentTotals: { clicks: 3, impressions: 48, position: 14.2 },
      previousTotals: { clicks: 1, impressions: 31, position: 16.0 },
      currentRows: [
        { query: 'edge delivery labs', clicks: 2, impressions: 21, position: 9.3 },
        { query: 'aem experiments', clicks: 0, impressions: 9, position: 22.1 },
      ],
      previousRows: [{ query: 'edge delivery labs', clicks: 1, impressions: 14, position: 11.0 }],
      comparison: { available: true, kind: 'equal-length-adjacent', days: 28 },
    });
  }
  return buildResult({
    ...base,
    currentTotals: { clicks: 0, impressions: 0 },
    previousTotals: { clicks: 0, impressions: 0 },
    currentRows: [],
    previousRows: [],
    comparison: { available: false, reason: 'No search data was reported for this URL in the previous period, so changes are not comparable.' },
  });
}

function bingResult(path) {
  if (path === '/personalization/experimentation') {
    throw new ApiError('PROVIDER_UNAVAILABLE', 'The provider is unavailable right now. Try again later. (Simulated failure in demo mode.)', 502);
  }
  const base = {
    provider: 'bing',
    property: `${ORIGIN}/`,
    requestedUrl: ORIGIN + path,
    metrics: {
      clicks: { available: true },
      impressions: { available: true },
      ctr: { available: true, definition: 'clicks / impressions (computed)' },
      position: { available: true, definition: 'Bing average impression position, impression-weighted across row dates (lower is better). Not comparable with Google position.' },
    },
    limits: { rowLimit: null, currentRowsTruncated: false, previousRowsTruncated: false },
    warnings: [{ code: 'bing-weekly', message: 'Bing updates page query statistics weekly and does not accept date ranges; periods follow the row dates Bing returns.' }],
  };
  if (path === '/martech/fpid') {
    return buildResult({
      ...base,
      periods: { current: { start: '2026-10-12', end: '2026-11-02' }, previous: { start: '2026-09-14', end: '2026-10-05' }, granularity: 'week' },
      freshness: { latestDate: '2026-11-02', dataState: 'as-returned', note: 'Latest Bing row date 2026-11-02; Bing row dates are weekly. Bing updates this data weekly.' },
      summarySource: 'derived-from-query-rows',
      currentTotals: { clicks: 46, impressions: 1890, position: 6.8 },
      previousTotals: { clicks: 39, impressions: 1702, position: 7.1 },
      currentRows: [
        { query: 'fpid adobe', clicks: 19, impressions: 410, position: 3.2 },
        { query: 'first party device id', clicks: 12, impressions: 690, position: 7.9 },
        { query: 'ecid vs fpid', clicks: 9, impressions: 330, position: 5.1 },
        { query: 'what is fpid', clicks: 6, impressions: 460, position: 9.4 },
      ],
      previousRows: [
        { query: 'fpid adobe', clicks: 15, impressions: 380, position: 3.6 },
        { query: 'first party device id', clicks: 11, impressions: 640, position: 8.2 },
        { query: 'ecid vs fpid', clicks: 8, impressions: 300, position: 5.4 },
        { query: 'what is fpid', clicks: 5, impressions: 382, position: 9.9 },
      ],
      comparison: { available: true, kind: 'row-date-windows', days: 28, rowDates: { current: 4, previous: 4 } },
      warnings: [...base.warnings, { code: 'derived-totals', message: 'Bing does not list this page among its top pages, so page totals are summed from the returned query rows and may undercount.' }],
    });
  }
  if (path === '/labs') {
    return buildResult({
      ...base,
      periods: { current: { start: '2026-10-19', end: '2026-11-02' }, previous: null, granularity: 'week' },
      freshness: { latestDate: '2026-11-02', dataState: 'as-returned', note: 'Latest Bing row date 2026-11-02; Bing row dates are weekly.' },
      summarySource: 'derived-from-query-rows',
      currentTotals: { clicks: 1, impressions: 12, position: 11.0 },
      previousTotals: null,
      currentRows: [{ query: 'edge delivery labs', clicks: 1, impressions: 12, position: 11.0 }],
      previousRows: null,
      comparison: { available: false, reason: 'Bing returned no rows dated in the preceding period, so a comparison is not available.' },
    });
  }
  return buildResult({
    ...base,
    periods: { current: null, previous: null, granularity: 'unknown' },
    freshness: { latestDate: null, dataState: 'as-returned', note: 'Bing returned no data for this URL.' },
    summarySource: 'page-totals',
    currentTotals: { clicks: 0, impressions: 0 },
    previousTotals: null,
    currentRows: [],
    previousRows: null,
    comparison: { available: false, reason: 'No Bing data for this URL.' },
  });
}

const DEMO_NOW = Date.parse('2026-11-09T12:00:00Z');
const SC_LINK = 'https://search.google.com/search-console/inspect';

function inspectionRaw(path) {
  const url = ORIGIN + path;
  if (path === '/about') {
    return {
      inspectionResultLink: SC_LINK,
      indexStatusResult: {
        verdict: 'NEUTRAL',
        coverageState: 'Crawled - currently not indexed',
        robotsTxtState: 'ALLOWED',
        indexingState: 'INDEXING_ALLOWED',
        pageFetchState: 'SUCCESSFUL',
        lastCrawlTime: '2026-10-21T08:14:02Z',
        userCanonical: url,
        crawledAs: 'MOBILE',
        sitemap: [`${ORIGIN}/sitemap.xml`],
      },
    };
  }
  if (path === '/personalization/experimentation') {
    return {
      inspectionResultLink: SC_LINK,
      indexStatusResult: {
        verdict: 'NEUTRAL',
        coverageState: 'Duplicate, Google chose different canonical than user',
        robotsTxtState: 'ALLOWED',
        indexingState: 'INDEXING_ALLOWED',
        pageFetchState: 'SUCCESSFUL',
        lastCrawlTime: '2026-11-01T17:40:11Z',
        googleCanonical: `${ORIGIN}/personalization/personalization-and-optimization`,
        userCanonical: url,
        crawledAs: 'MOBILE',
      },
    };
  }
  return {
    inspectionResultLink: SC_LINK,
    indexStatusResult: {
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      robotsTxtState: 'ALLOWED',
      indexingState: 'INDEXING_ALLOWED',
      pageFetchState: 'SUCCESSFUL',
      lastCrawlTime: path === '/labs' ? '2026-10-02T03:22:45Z' : '2026-11-06T22:05:31Z',
      googleCanonical: url,
      userCanonical: url,
      crawledAs: 'MOBILE',
      sitemap: [`${ORIGIN}/sitemap.xml`],
    },
    ...(path === '/martech/fpid' ? {
      richResultsResult: {
        verdict: 'PASS',
        detectedItems: [{ richResultType: 'Breadcrumbs', items: [{ name: 'Unnamed item', issues: [] }] }],
      },
    } : {}),
  };
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

export function createDemoApi() {
  return {
    mode: 'demo',
    async config() {
      return {
        site: DEMO_SITE,
        providers: {
          google: { enabled: true, configured: true, auth: 'oauth' },
          bing: { enabled: true, configured: true, auth: 'apiKey' },
        },
        user: { id: 'demo-user' },
      };
    },
    async status() {
      return {
        google: { enabled: true, configured: true, connected: true, account: 'demo@example.com' },
        bing: { enabled: true, configured: true, connected: true, account: 'Deployment API key (demo)' },
      };
    },
    async properties() {
      return { properties: [{ property: 'sc-domain:edgepatterns.dev', accessible: true, permissionLevel: 'siteOwner' }] };
    },
    async report(provider, pageUrl) {
      await wait(250);
      const path = new URL(pageUrl).pathname;
      return provider === 'bing' ? bingResult(path) : googleResult(path);
    },
    async inspect(pageUrl) {
      await wait(350);
      const path = new URL(pageUrl).pathname;
      return normalizeInspection(inspectionRaw(path), {
        url: pageUrl, property: 'sc-domain:edgepatterns.dev', now: DEMO_NOW, inspectedAt: '2026-11-09T12:00:00.000Z',
      });
    },
    async pageCheck(pageUrl) {
      return { url: pageUrl, finalUrl: pageUrl, status: 'ok', canonical: { status: 'match', canonical: pageUrl } };
    },
    async startOAuth() { throw new ApiError('BAD_REQUEST', 'Connections are simulated in demo mode.', 400); },
    async disconnect() { return { disconnected: true }; },
  };
}
