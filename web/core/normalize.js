/**
 * Provider-neutral result shape. Providers stay separate in the UI; this only
 * guarantees that each result carries the same kinds of facts:
 * provider/property, requested vs reported URL, actual dates and freshness,
 * metric availability, summary, query rows, comparison availability, limits
 * and warnings.
 */

import { metricSet, compareMetricSets, joinQueryRows } from './metrics.js';

export const RESULT_VERSION = 1;

/**
 * @param {object} p
 * @param {'google'|'bing'} p.provider
 * @param {string} p.property            provider property / site id
 * @param {string} p.requestedUrl
 * @param {string} [p.reportedUrl]
 * @param {{current:{start,end}, previous:{start,end}|null}} p.periods
 * @param {object} p.freshness           { latestDate, dataState, note }
 * @param {object} p.metrics             availability/definitions
 * @param {object} p.currentTotals       { clicks, impressions, position }
 * @param {object|null} p.previousTotals
 * @param {'page-totals'|'derived-from-query-rows'} p.summarySource
 * @param {Array} p.currentRows          [{ query, clicks, impressions, position }]
 * @param {Array|null} p.previousRows
 * @param {object} p.limits              { rowLimit, currentRowsTruncated, previousRowsTruncated }
 * @param {{available:boolean, reason?:string}} p.comparison
 * @param {Array<{code:string,message:string}>} [p.warnings]
 */
export function buildResult(p) {
  const current = metricSet(p.currentTotals || {});
  const previous = p.comparison?.available && p.previousTotals ? metricSet(p.previousTotals) : null;
  const joined = joinQueryRows(p.currentRows || [], p.comparison?.available ? (p.previousRows || []) : null);
  const warnings = [...(p.warnings || [])];

  // Coverage of returned query rows vs page totals (Google: anonymised queries are omitted).
  if (p.summarySource === 'page-totals' && current.clicks > 0) {
    const rowClicks = (p.currentRows || []).reduce((a, r) => a + (r.clicks || 0), 0);
    const share = rowClicks / current.clicks;
    if (share < 0.95) {
      warnings.push({
        code: 'partial-query-coverage',
        message: `Returned queries account for ${Math.round(share * 100)}% of this page's clicks; `
          + 'the rest come from queries the provider does not list.',
      });
    }
  }

  return {
    version: RESULT_VERSION,
    provider: p.provider,
    property: p.property,
    requestedUrl: p.requestedUrl,
    reportedUrl: p.reportedUrl || p.requestedUrl,
    periods: {
      current: p.periods.current,
      previous: p.comparison?.available ? p.periods.previous : null,
      granularity: p.periods.granularity || 'day',
    },
    freshness: p.freshness,
    metrics: p.metrics,
    summary: {
      source: p.summarySource,
      current,
      previous,
      change: compareMetricSets(current, previous),
    },
    queries: joined.rows,
    onlyInPrevious: joined.onlyInPrevious,
    comparison: p.comparison,
    limits: {
      ...p.limits,
      currentRowCount: (p.currentRows || []).length,
      previousRowCount: p.comparison?.available ? (p.previousRows || []).length : 0,
    },
    warnings,
    hasData: (current.impressions || 0) > 0 || (p.currentRows || []).length > 0,
  };
}
