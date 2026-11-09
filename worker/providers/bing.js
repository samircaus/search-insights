/**
 * Bing Webmaster Tools adapter (JSON/HTTP API; SOAP and POX were retired on 2026-08-31).
 *
 * Verified from the official reference (learn.microsoft.com IWebmasterApi):
 *  - GetPageQueryStats(siteUrl, page) -> QueryStats[] (Query, Clicks, Impressions,
 *    AvgClickPosition, AvgImpressionPosition, Date). "The data will be updated every week."
 *  - GetPageStats(siteUrl) -> QueryStats[] for top pages (Query holds the page URL).
 *  - No date-range parameters exist. Rows carry a Date in Microsoft JSON format.
 *
 * We therefore build periods from the row dates Bing returns and only offer a
 * comparison when two adjacent windows contain the same number of row dates.
 * Bing figures are search statistics only; they are not Copilot citations or
 * AI-answer visibility.
 */
import { AppError } from '../errors.js';
import { parseMsJsonDate, addDays } from '../../web/core/dates.js';
import { buildResult } from '../../web/core/normalize.js';
import { weightedPosition, isNum } from '../../web/core/metrics.js';
import { isUrlInBingSite } from '../../web/core/url-resolver.js';

export const BING_API_KEY_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
export const BING_OAUTH_BASE = 'https://www.bing.com/webmaster/api.svc/json';

export function mapBingError(status, body) {
  const msg = String(body?.Message || '');
  if (status === 401 || /InvalidApiKey|Unauthorized|token/i.test(msg)) {
    return new AppError('REAUTH_REQUIRED', `bing ${status} ${msg}`);
  }
  if (/NotAuthorized|AccessDenied|not verified|UserNotAuthorized/i.test(msg) || status === 403) {
    return new AppError('PROPERTY_ACCESS_DENIED', `bing ${status} ${msg}`);
  }
  if (status === 429 || /ThrottleUser|Quota/i.test(msg)) return new AppError('RATE_LIMITED', `bing ${status} ${msg}`);
  if (status >= 500) return new AppError('PROVIDER_UNAVAILABLE', `bing ${status}`);
  return new AppError('PROVIDER_UNAVAILABLE', `bing ${status} ${msg}`.slice(0, 200));
}

/**
 * @param {{apiKey?:string, accessToken?:string, fetchImpl?:Function}} auth
 */
export function bingClient({ apiKey, accessToken, fetchImpl = fetch }) {
  if (!apiKey && !accessToken) throw new AppError('NOT_CONFIGURED', 'bing credentials');
  const base = apiKey ? BING_API_KEY_BASE : BING_OAUTH_BASE;
  async function get(method, params) {
    const qs = new URLSearchParams(params);
    if (apiKey) qs.set('apikey', apiKey);
    let resp;
    try {
      resp = await fetchImpl(`${base}/${method}?${qs}`, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          accept: 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
      });
    } catch (e) {
      throw new AppError('PROVIDER_UNAVAILABLE', `bing network ${e.message}`);
    }
    const text = await resp.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { Message: text.slice(0, 120) }; }
    if (!resp.ok || body.ErrorCode !== undefined) throw mapBingError(resp.status, body);
    return Array.isArray(body.d) ? body.d : [];
  }
  return {
    getUserSites: () => get('GetUserSites', {}),
    getPageQueryStats: (siteUrl, page) => get('GetPageQueryStats', { siteUrl, page }),
    getPageStats: (siteUrl) => get('GetPageStats', { siteUrl }),
  };
}

function cleanPosition(v) {
  return isNum(v) && v > 0 ? v : null;
}

export function parseBingRows(rows) {
  return rows.map((r) => ({
    key: r.Query,
    date: parseMsJsonDate(r.Date),
    clicks: isNum(r.Clicks) ? r.Clicks : 0,
    impressions: isNum(r.Impressions) ? r.Impressions : 0,
    position: cleanPosition(r.AvgImpressionPosition),
    clickPosition: cleanPosition(r.AvgClickPosition),
  })).filter((r) => r.date && typeof r.key === 'string');
}

/** Detect the spacing of Bing's row dates. */
export function detectGranularity(dates) {
  const uniq = [...new Set(dates)].sort();
  if (uniq.length < 2) return 'unknown';
  const gaps = new Set();
  for (let i = 1; i < uniq.length; i += 1) {
    gaps.add(Math.round((Date.parse(uniq[i]) - Date.parse(uniq[i - 1])) / 86400000));
  }
  if (gaps.size === 1 && gaps.has(7)) return 'week';
  if ([...gaps].every((g) => g === 1)) return 'day';
  if ([...gaps].every((g) => g % 7 === 0)) return 'week';
  return 'irregular';
}

/**
 * Split row dates into a current and previous window of `days` ending on the
 * latest row date. Comparison is only offered when both windows contain the
 * same number of row dates.
 */
export function bingWindows(dates, days = 28) {
  const uniq = [...new Set(dates)].sort();
  if (!uniq.length) return null;
  const latest = uniq[uniq.length - 1];
  const curStart = addDays(latest, -(days - 1));
  const prevEnd = addDays(curStart, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  const cur = uniq.filter((d) => d >= curStart && d <= latest);
  const prev = uniq.filter((d) => d >= prevStart && d <= prevEnd);
  const granularity = detectGranularity(uniq);
  const comparable = prev.length > 0 && prev.length === cur.length && granularity !== 'irregular';
  return {
    granularity,
    allDates: uniq,
    current: { start: cur[0], end: latest, rowDates: cur },
    previous: prev.length ? { start: prev[0], end: prev[prev.length - 1], rowDates: prev } : null,
    comparable,
    reason: comparable ? undefined
      : prev.length === 0
        ? 'Bing returned no rows dated in the preceding period, so a comparison is not available.'
        : `Bing returned ${cur.length} row date(s) in the current period and ${prev.length} in the previous one; the periods are not comparable.`,
  };
}

function aggregate(rows) {
  const by = new Map();
  for (const r of rows) {
    const e = by.get(r.key) || { query: r.key, clicks: 0, impressions: 0, parts: [] };
    e.clicks += r.clicks;
    e.impressions += r.impressions;
    e.parts.push(r);
    by.set(r.key, e);
  }
  return [...by.values()].map((e) => ({
    query: e.query,
    clicks: e.clicks,
    impressions: e.impressions,
    position: weightedPosition(e.parts),
  })).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
}

function sameUrl(a, b) {
  const n = (u) => {
    try {
      const x = new URL(u);
      return `${x.origin.toLowerCase()}${decodeURIComponent(x.pathname)}`;
    } catch {
      return String(u);
    }
  };
  return n(a) === n(b);
}

export async function bingReport({
  client, siteUrl, url, days = 28,
}) {
  if (!isUrlInBingSite(url, siteUrl)) throw new AppError('URL_NOT_ALLOWED', 'url outside bing site');
  const [queryRowsRaw, pageRowsRaw] = await Promise.all([
    client.getPageQueryStats(siteUrl, url),
    client.getPageStats(siteUrl).catch(() => []),
  ]);
  const queryRows = parseBingRows(queryRowsRaw);
  const pageRows = parseBingRows(pageRowsRaw).filter((r) => sameUrl(r.key, url));
  const warnings = [{
    code: 'bing-weekly',
    message: 'Bing updates page query statistics weekly and does not accept date ranges; periods follow the row dates Bing returns.',
  }];
  const dates = [...queryRows.map((r) => r.date), ...pageRows.map((r) => r.date)];
  const win = bingWindows(dates, days);

  if (!win) {
    return buildResult({
      provider: 'bing',
      property: siteUrl,
      requestedUrl: url,
      periods: { current: null, previous: null, granularity: 'unknown' },
      freshness: { latestDate: null, dataState: 'as-returned', note: 'Bing returned no data for this URL.' },
      metrics: bingMetricDefs(),
      currentTotals: { clicks: 0, impressions: 0 },
      previousTotals: null,
      summarySource: 'page-totals',
      currentRows: [],
      previousRows: null,
      limits: { rowLimit: null },
      comparison: { available: false, reason: 'No Bing data for this URL.' },
      warnings,
    });
  }

  const inRange = (r, range) => range && r.date >= range.start && r.date <= range.end;
  const curQ = aggregate(queryRows.filter((r) => inRange(r, win.current)));
  const prevQ = win.previous ? aggregate(queryRows.filter((r) => inRange(r, win.previous))) : [];

  let summarySource = 'page-totals';
  let curTotals;
  let prevTotals = null;
  const pageCur = pageRows.filter((r) => inRange(r, win.current));
  if (pageCur.length) {
    const sum = (rs) => ({
      clicks: rs.reduce((a, r) => a + r.clicks, 0),
      impressions: rs.reduce((a, r) => a + r.impressions, 0),
      position: weightedPosition(rs),
    });
    curTotals = sum(pageCur);
    const pagePrev = pageRows.filter((r) => inRange(r, win.previous));
    prevTotals = pagePrev.length ? sum(pagePrev) : null;
  } else {
    // GetPageStats lists top pages only. If this page is not among them, totals
    // can only be derived from the returned query rows, which may undercount.
    summarySource = 'derived-from-query-rows';
    const sumQ = (rs) => ({
      clicks: rs.reduce((a, r) => a + r.clicks, 0),
      impressions: rs.reduce((a, r) => a + r.impressions, 0),
      position: weightedPosition(rs),
    });
    curTotals = sumQ(curQ);
    prevTotals = win.previous ? sumQ(prevQ) : null;
    warnings.push({
      code: 'derived-totals',
      message: 'Bing does not list this page among its top pages, so page totals are summed from the returned query rows and may undercount.',
    });
  }

  return buildResult({
    provider: 'bing',
    property: siteUrl,
    requestedUrl: url,
    periods: { current: { start: win.current.start, end: win.current.end }, previous: win.previous && { start: win.previous.start, end: win.previous.end }, granularity: win.granularity },
    freshness: {
      latestDate: win.current.end,
      dataState: 'as-returned',
      note: `Latest Bing row date ${win.current.end}; Bing row dates are ${win.granularity === 'week' ? 'weekly' : win.granularity}. Bing updates this data weekly.`,
    },
    metrics: bingMetricDefs(),
    currentTotals: curTotals,
    previousTotals: prevTotals,
    summarySource,
    currentRows: curQ,
    previousRows: prevQ,
    limits: { rowLimit: null, currentRowsTruncated: false, previousRowsTruncated: false },
    comparison: win.comparable && prevTotals
      ? { available: true, kind: 'row-date-windows', days, rowDates: { current: win.current.rowDates.length, previous: win.previous.rowDates.length } }
      : { available: false, reason: win.reason || 'Bing did not return comparable previous-period data.' },
    warnings,
  });
}

export function bingMetricDefs() {
  return {
    clicks: { available: true },
    impressions: { available: true },
    ctr: { available: true, definition: 'clicks / impressions (computed)' },
    position: {
      available: true,
      definition: 'Bing average impression position, impression-weighted across row dates (lower is better). Not comparable with Google position.',
    },
  };
}
