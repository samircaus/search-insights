/**
 * Deterministic, transparent opportunity rules.
 *
 * Every card states why it was flagged, the evidence and dates behind it, and
 * cautious checks. Rules never claim causes, never claim content is missing,
 * and never promise ranking changes. When the page has too little data the
 * rules return no cards and explain why (see docs/opportunities.md).
 */

import {
  isNum, fmtInt, fmtPct, fmtPos, fmtRelChange, fmtPp, fmtPosChange,
} from './metrics.js';

export const DEFAULT_THRESHOLDS = Object.freeze({
  minPageImpressions: 100,
  lowCtr: { minImpressions: 100, maxPosition: 10, maxRatioToPageCtr: 0.5, maxCards: 3 },
  nearFirstPage: { minPosition: 8, maxPosition: 20, minImpressions: 30, maxCards: 3 },
  decliningClicks: { minPreviousClicks: 20, minRelativeDrop: 0.2, minAbsoluteDrop: 5 },
  newlyVisible: { minImpressions: 30, maxCards: 3 },
});

export function mergeThresholds(overrides = {}) {
  const out = structuredClone(DEFAULT_THRESHOLDS);
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v && typeof v === 'object' && out[k] && typeof out[k] === 'object') Object.assign(out[k], v);
    else if (isNum(v)) out[k] = v;
  }
  return out;
}

const PROVIDER_LABEL = { google: 'Google Search', bing: 'Bing' };

function queryEvidence(row) {
  const c = row.current;
  const ev = [
    { label: 'Impressions', value: fmtInt(c.impressions) },
    { label: 'Clicks', value: fmtInt(c.clicks) },
    { label: 'CTR', value: fmtPct(c.ctr) },
  ];
  if (isNum(c.position)) ev.push({ label: 'Avg. position', value: fmtPos(c.position) });
  return ev;
}

function lowCtrCards(result, t, pageCtr) {
  const cfg = t.lowCtr;
  if (!isNum(pageCtr) || pageCtr <= 0) return [];
  const rows = result.queries.filter((r) => isNum(r.current.impressions)
    && r.current.impressions >= cfg.minImpressions
    && isNum(r.current.position) && r.current.position <= cfg.maxPosition
    && isNum(r.current.ctr) && r.current.ctr <= pageCtr * cfg.maxRatioToPageCtr);
  rows.sort((a, b) => b.current.impressions - a.current.impressions);
  return rows.slice(0, cfg.maxCards).map((row) => ({
    id: `low-ctr:${row.query}`,
    type: 'low-ctr',
    strength: 'review',
    title: `Low click-through for “${row.query}”`,
    why: `This query had ${fmtInt(row.current.impressions)} impressions at an average position of `
      + `${fmtPos(row.current.position)}, but a CTR of ${fmtPct(row.current.ctr)}, well below `
      + `this page's overall CTR of ${fmtPct(pageCtr)}.`,
    evidence: [...queryEvidence(row), { label: 'Page CTR', value: fmtPct(pageCtr) }],
    queries: [row.query],
    checks: [
      `Review whether the page title and meta description clearly reflect the intent behind “${row.query}”.`,
      'Check how the result appears for this query (rich results, other results on the page) before changing anything.',
    ],
    caveats: [
      'A low CTR is not necessarily caused by the title or description; search features, intent mismatch or brand results can all lower it.',
    ],
  }));
}

function nearFirstPageCards(result, t, exclude) {
  const cfg = t.nearFirstPage;
  const rows = result.queries.filter((r) => !exclude.has(r.query)
    && isNum(r.current.position)
    && r.current.position >= cfg.minPosition && r.current.position <= cfg.maxPosition
    && isNum(r.current.impressions) && r.current.impressions >= cfg.minImpressions);
  rows.sort((a, b) => b.current.impressions - a.current.impressions);
  return rows.slice(0, cfg.maxCards).map((row) => ({
    id: `near-first-page:${row.query}`,
    type: 'near-first-page',
    strength: 'consider',
    title: `“${row.query}” is near the first-page boundary`,
    why: `Average position ${fmtPos(row.current.position)} with ${fmtInt(row.current.impressions)} impressions. `
      + 'A small improvement could move it onto the first page of results.',
    evidence: queryEvidence(row),
    queries: [row.query],
    checks: [
      `Read the page as someone searching “${row.query}”: does it answer that question directly and early?`,
      'Check whether a section, example or internal link would make the answer easier to find.',
    ],
    caveats: [
      'Average position is an aggregate across searches and locations; individual results vary.',
      'Editing the page does not guarantee a change in position.',
    ],
  }));
}

function decliningClicksCard(result, t) {
  const cfg = t.decliningClicks;
  const s = result.summary;
  if (!result.comparison?.available || !s.previous) return [];
  const cur = s.current.clicks;
  const prev = s.previous.clicks;
  if (!isNum(cur) || !isNum(prev) || prev < cfg.minPreviousClicks) return [];
  const drop = prev - cur;
  if (drop < cfg.minAbsoluteDrop || drop / prev < cfg.minRelativeDrop) return [];
  const ch = s.change;
  // Queries with the largest click declines among rows returned in both periods.
  const decliners = result.queries
    .filter((r) => r.previousStatus === 'present' && r.previous.clicks > r.current.clicks)
    .sort((a, b) => (b.previous.clicks - b.current.clicks) - (a.previous.clicks - a.current.clicks))
    .slice(0, 3);
  return [{
    id: 'declining-clicks',
    type: 'declining-clicks',
    strength: 'review',
    title: 'Clicks to this page declined',
    why: `Clicks fell from ${fmtInt(prev)} to ${fmtInt(cur)} (${fmtRelChange(ch.clicks)}) compared with the previous period.`,
    evidence: [
      { label: 'Clicks', value: `${fmtInt(prev)} → ${fmtInt(cur)} (${fmtRelChange(ch.clicks)})` },
      { label: 'Impressions', value: `${fmtInt(s.previous.impressions)} → ${fmtInt(s.current.impressions)} (${fmtRelChange(ch.impressions)})` },
      { label: 'CTR', value: `${fmtPct(s.previous.ctr)} → ${fmtPct(s.current.ctr)} (${fmtPp(ch.ctrPp)})` },
      ...(isNum(s.current.position) && isNum(s.previous.position)
        ? [{ label: 'Avg. position', value: `${fmtPos(s.previous.position)} → ${fmtPos(s.current.position)} (${fmtPosChange(ch.position)})` }]
        : []),
      ...decliners.map((r) => ({
        label: `“${r.query}” clicks`,
        value: `${fmtInt(r.previous.clicks)} → ${fmtInt(r.current.clicks)}`,
      })),
    ],
    queries: decliners.map((r) => r.query),
    checks: [
      'Compare the impression, CTR and position changes above: fewer impressions suggests lower demand or visibility; a lower CTR at similar impressions suggests the result is chosen less often.',
      'Check whether the page content, title or URL changed between the two periods.',
      'Consider seasonality or news events that may affect demand for these topics.',
    ],
    caveats: [
      'A traffic change on its own does not prove a cause.',
    ],
  }];
}

function newlyVisibleCards(result, t, exclude) {
  const cfg = t.newlyVisible;
  if (!result.comparison?.available) return [];
  // Only meaningful if the previous period returned rows and was not truncated.
  if (!result.limits || result.limits.previousRowsTruncated || !result.limits.previousRowCount) return [];
  const rows = result.queries.filter((r) => !exclude.has(r.query)
    && r.previousStatus === 'not-in-returned-rows'
    && isNum(r.current.impressions) && r.current.impressions >= cfg.minImpressions);
  rows.sort((a, b) => b.current.impressions - a.current.impressions);
  return rows.slice(0, cfg.maxCards).map((row) => ({
    id: `newly-visible:${row.query}`,
    type: 'newly-visible',
    strength: 'consider',
    title: `“${row.query}” appears in this period's data`,
    why: `${fmtInt(row.current.impressions)} impressions this period. It was not among the top queries in the previous period.`,
    evidence: queryEvidence(row),
    queries: [row.query],
    checks: [
      `Consider whether “${row.query}” reflects an audience need this page should address.`,
      'If it does, check whether the page already covers it before adding anything.',
    ],
    caveats: [
      'Search providers return top rows only and omit some queries, so this query may have had impressions before without being returned.',
    ],
  }));
}

/**
 * @param {object} result normalized provider result (see worker/normalize)
 * @param {object} thresholds merged thresholds
 */
export function findOpportunities(result, thresholds = DEFAULT_THRESHOLDS) {
  const t = thresholds;
  if (!result || !result.summary) return { status: 'no-data', cards: [] };
  const s = result.summary.current;
  if (!isNum(s.impressions) || s.impressions === 0) {
    return { status: 'no-data', cards: [], reason: 'No search impressions were reported for this URL in the selected period.' };
  }
  if (s.impressions < t.minPageImpressions) {
    return {
      status: 'insufficient-data',
      cards: [],
      reason: `This page had ${fmtInt(s.impressions)} impressions in the period; recommendations start at `
        + `${fmtInt(t.minPageImpressions)} impressions so that small numbers are not over-interpreted.`,
    };
  }
  const pageCtr = s.ctr;
  const cards = [];
  cards.push(...decliningClicksCard(result, t));
  const low = lowCtrCards(result, t, pageCtr);
  cards.push(...low);
  const used = new Set(low.flatMap((c) => c.queries));
  const near = nearFirstPageCards(result, t, used);
  cards.push(...near);
  near.forEach((c) => c.queries.forEach((q) => used.add(q)));
  cards.push(...newlyVisibleCards(result, t, used));
  const provider = PROVIDER_LABEL[result.provider] || result.provider;
  cards.forEach((c) => {
    c.provider = provider;
    c.dates = result.periods;
  });
  return {
    status: cards.length ? 'ok' : 'none',
    cards,
    reason: cards.length ? undefined : 'No rule matched for this page. That is not a problem in itself.',
  };
}
