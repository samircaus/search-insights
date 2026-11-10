/**
 * Google Search Console adapter (Search Analytics API, read-only scope).
 *
 * Requests per report (all `type: web`, `dataState: final`):
 *  1. freshness  - property-wide, grouped by date, last ~14 days -> latest finalized date
 *  2-3. totals   - page filter (equals), no dimensions, current + previous window
 *  4-5. queries  - page filter, dimensions [query], current + previous window
 *
 * Page totals are fetched separately and never derived from query rows:
 * Search Console omits anonymised queries and returns top rows only.
 */
import { AppError } from '../errors.js';
import { comparisonWindows, addDays, todayInTimeZone } from '../../web/core/dates.js';
import { buildResult } from '../../web/core/normalize.js';
import { isUrlInGoogleProperty } from '../../web/core/url-resolver.js';
import { normalizeInspection } from '../../web/core/inspection.js';

const API = 'https://www.googleapis.com/webmasters/v3';
const INSPECT_API = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
export const GSC_TIMEZONE = 'America/Los_Angeles';

export function mapGoogleError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
  if (status === 401) return new AppError('REAUTH_REQUIRED', `google 401 ${reason}`);
  if (status === 403) {
    if (/rateLimit|quota|RESOURCE_EXHAUSTED/i.test(`${reason} ${body?.error?.message || ''}`)) return new AppError('RATE_LIMITED', `google 403 ${reason}`);
    return new AppError('PROPERTY_ACCESS_DENIED', `google 403 ${reason}`);
  }
  if (status === 404) return new AppError('PROPERTY_ACCESS_DENIED', 'google 404 property not found');
  if (status === 429) return new AppError('RATE_LIMITED', 'google 429');
  if (status === 400) return new AppError('BAD_REQUEST', `google 400 ${body?.error?.message || ''}`.slice(0, 200));
  return new AppError('PROVIDER_UNAVAILABLE', `google ${status}`);
}

export function googleClient({ accessToken, fetchImpl = fetch }) {
  async function call(path, init = {}) {
    let resp;
    try {
      resp = await fetchImpl(`${API}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
      });
    } catch (e) {
      throw new AppError('PROVIDER_UNAVAILABLE', `google network ${e.message}`);
    }
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw mapGoogleError(resp.status, body);
    return body;
  }
  async function inspect(property, url) {
    let resp;
    try {
      resp = await fetchImpl(INSPECT_API, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ inspectionUrl: url, siteUrl: property, languageCode: 'en-US' }),
      });
    } catch (e) {
      throw new AppError('PROVIDER_UNAVAILABLE', `google network ${e.message}`);
    }
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw mapGoogleError(resp.status, body);
    return body.inspectionResult || {};
  }
  return {
    inspect,
    listSites: () => call('/sites').then((b) => b.siteEntry || []),
    query: (property, request) => call(
      `/sites/${encodeURIComponent(property)}/searchAnalytics/query`,
      { method: 'POST', body: JSON.stringify(request) },
    ),
  };
}

/** Latest finalized date with data for the property (property-wide, PT calendar date). */
export async function latestFinalDate(client, property, now = new Date()) {
  const today = todayInTimeZone(GSC_TIMEZONE, now);
  const body = await client.query(property, {
    startDate: addDays(today, -14),
    endDate: today,
    dimensions: ['date'],
    type: 'web',
    dataState: 'final',
    rowLimit: 30,
  });
  const dates = (body.rows || []).map((r) => r.keys?.[0]).filter(Boolean).sort();
  return { latestDate: dates.length ? dates[dates.length - 1] : null, today };
}

function pageFilter(url) {
  return [{ groupType: 'and', filters: [{ dimension: 'page', operator: 'equals', expression: url }] }];
}

async function pageTotals(client, property, url, range) {
  const body = await client.query(property, {
    startDate: range.start,
    endDate: range.end,
    type: 'web',
    dataState: 'final',
    dimensionFilterGroups: pageFilter(url),
  });
  const row = body.rows?.[0];
  return row
    ? { clicks: row.clicks, impressions: row.impressions, position: row.position }
    : { clicks: 0, impressions: 0, position: null };
}

/**
 * Page query rows, paginated with startRow until fewer than pageSize rows
 * return or `maxRows` is reached.
 */
async function pageQueries(client, property, url, range, maxRows) {
  const pageSize = Math.min(maxRows, 25000);
  const rows = [];
  let startRow = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const body = await client.query(property, {
      startDate: range.start,
      endDate: range.end,
      dimensions: ['query'],
      type: 'web',
      dataState: 'final',
      dimensionFilterGroups: pageFilter(url),
      rowLimit: pageSize,
      startRow,
    });
    const batch = body.rows || [];
    rows.push(...batch.map((r) => ({
      query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position,
    })));
    if (batch.length < pageSize || rows.length >= maxRows) break;
    startRow += pageSize;
  }
  return { rows: rows.slice(0, maxRows), truncated: rows.length >= maxRows };
}

export async function googleReport({
  client, property, url, days = 28, maxRows = 1000, now,
}) {
  if (!isUrlInGoogleProperty(url, property)) throw new AppError('URL_NOT_ALLOWED', 'url outside property');
  const { latestDate, today } = await latestFinalDate(client, property, now);
  const warnings = [];
  if (!latestDate) {
    // Property has no finalized data in the last two weeks; nothing to compare.
    return buildResult({
      provider: 'google',
      property,
      requestedUrl: url,
      periods: comparisonWindows(addDays(today, -3), days),
      freshness: { latestDate: null, dataState: 'final', timeZone: GSC_TIMEZONE, note: 'No finalized data in the last 14 days for this property.' },
      metrics: googleMetricDefs(),
      currentTotals: { clicks: 0, impressions: 0 },
      previousTotals: null,
      summarySource: 'page-totals',
      currentRows: [],
      previousRows: null,
      limits: { rowLimit: maxRows },
      comparison: { available: false, reason: 'The property has no recent finalized data.' },
      warnings: [{ code: 'no-recent-data', message: 'No finalized Search Console data in the last 14 days for this property.' }],
    });
  }
  const win = comparisonWindows(latestDate, days);
  const [curTotals, prevTotals, curQ, prevQ] = await Promise.all([
    pageTotals(client, property, url, win.current),
    pageTotals(client, property, url, win.previous),
    pageQueries(client, property, url, win.current, maxRows),
    pageQueries(client, property, url, win.previous, maxRows),
  ]);
  if (curQ.truncated) {
    warnings.push({ code: 'rows-truncated', message: `Only the top ${maxRows} queries were loaded for the current period.` });
  }
  const comparable = prevTotals.impressions > 0 || prevQ.rows.length > 0;
  return buildResult({
    provider: 'google',
    property,
    requestedUrl: url,
    periods: win,
    freshness: {
      latestDate,
      dataState: 'final',
      timeZone: GSC_TIMEZONE,
      note: `Finalized data through ${latestDate} (Pacific Time). Recent days are excluded until Google finalizes them.`,
    },
    metrics: googleMetricDefs(),
    currentTotals: curTotals,
    previousTotals: prevTotals,
    summarySource: 'page-totals',
    currentRows: curQ.rows,
    previousRows: prevQ.rows,
    limits: {
      rowLimit: maxRows,
      currentRowsTruncated: curQ.truncated,
      previousRowsTruncated: prevQ.truncated,
    },
    comparison: comparable
      ? { available: true, kind: 'equal-length-adjacent', days }
      : { available: false, reason: 'No search data was reported for this URL in the previous period, so changes are not comparable.' },
    warnings,
  });
}

export function googleMetricDefs() {
  return {
    clicks: { available: true },
    impressions: { available: true },
    ctr: { available: true, definition: 'clicks / impressions' },
    position: { available: true, definition: 'Average topmost position of the page in Google results (lower is better).' },
  };
}

/** Allowed properties the connected account can actually access. */
export async function accessibleProperties(client, allowed) {
  const entries = await client.listSites();
  const byUrl = new Map(entries.map((e) => [e.siteUrl, e.permissionLevel]));
  return allowed.map((p) => ({
    property: p,
    permissionLevel: byUrl.get(p) || null,
    accessible: !!byUrl.get(p) && byUrl.get(p) !== 'siteUnverifiedUser',
  }));
}

/**
 * URL Inspection for one page (Google's indexed version, not a live test).
 * Quota: 2,000 inspections/day and 600/minute per property, so results are cached.
 */
export async function googleInspection({ client, property, url, now }) {
  if (!isUrlInGoogleProperty(url, property)) throw new AppError('URL_NOT_ALLOWED', 'url outside property');
  const raw = await client.inspect(property, url);
  return normalizeInspection(raw, { url, property, now: now ?? Date.now() });
}
