import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResult } from '../web/core/normalize.js';
import { findOpportunities, mergeThresholds, DEFAULT_THRESHOLDS } from '../web/core/opportunities.js';
import { buildBrief, buildWorkspacePrompt, briefToHtml } from '../web/core/brief.js';
import { comparisonWindows } from '../web/core/dates.js';

function result({
  cur = { clicks: 300, impressions: 12000, position: 8 },
  prev = { clicks: 400, impressions: 12500, position: 7.5 },
  rows = [], prevRows = [], comparable = true, truncated = false,
} = {}) {
  return buildResult({
    provider: 'google',
    property: 'sc-domain:example.com',
    requestedUrl: 'https://example.com/page',
    periods: comparisonWindows('2026-11-05', 28),
    freshness: { latestDate: '2026-11-05', note: 'through 2026-11-05' },
    metrics: { position: { available: true } },
    currentTotals: cur,
    previousTotals: prev,
    summarySource: 'page-totals',
    currentRows: rows,
    previousRows: prevRows,
    limits: { rowLimit: 1000, currentRowsTruncated: truncated, previousRowsTruncated: truncated },
    comparison: comparable ? { available: true } : { available: false, reason: 'none' },
  });
}

test('low-volume pages produce no recommendations, with an explanation', () => {
  const r = result({ cur: { clicks: 2, impressions: 40, position: 12 }, rows: [{ query: 'x', clicks: 0, impressions: 40, position: 3 }] });
  const o = findOpportunities(r);
  assert.equal(o.status, 'insufficient-data');
  assert.equal(o.cards.length, 0);
  assert.match(o.reason, /40 impressions/);
});

test('no impressions -> no-data', () => {
  const o = findOpportunities(result({ cur: { clicks: 0, impressions: 0 }, rows: [] }));
  assert.equal(o.status, 'no-data');
});

test('low CTR rule uses impressions, position and page CTR; text is cautious', () => {
  const rows = [
    { query: 'low', clicks: 5, impressions: 1000, position: 3 }, // 0.5% vs page 2.5%
    { query: 'fine', clicks: 50, impressions: 1000, position: 3 },
    { query: 'deep', clicks: 0, impressions: 1000, position: 30 },
  ];
  const o = findOpportunities(result({ rows, prevRows: rows }));
  const low = o.cards.filter((c) => c.type === 'low-ctr');
  assert.deepEqual(low.map((c) => c.queries[0]), ['low']);
  assert.match(low[0].caveats.join(' '), /not necessarily caused/);
  assert.ok(low[0].evidence.some((e) => e.label === 'Page CTR'));
});

test('near-first-page rule flags positions 8-20 with enough impressions', () => {
  const rows = [
    { query: 'edge', clicks: 1, impressions: 300, position: 11 },
    { query: 'tiny', clicks: 0, impressions: 5, position: 11 },
  ];
  const o = findOpportunities(result({ rows, prevRows: rows }));
  const near = o.cards.filter((c) => c.type === 'near-first-page');
  assert.deepEqual(near.map((c) => c.queries[0]), ['edge']);
  assert.ok(near[0].caveats.some((c) => /does not guarantee/.test(c)));
});

test('declining clicks needs a valid comparison and meaningful drop', () => {
  const o1 = findOpportunities(result({ rows: [] }));
  assert.ok(o1.cards.some((c) => c.type === 'declining-clicks'));
  const card = o1.cards.find((c) => c.type === 'declining-clicks');
  assert.ok(card.evidence.some((e) => e.label === 'Impressions'));
  assert.ok(card.evidence.some((e) => e.label === 'CTR' && /pp/.test(e.value)));
  assert.match(card.caveats.join(' '), /does not prove a cause/);
  const o2 = findOpportunities(result({ rows: [], comparable: false }));
  assert.ok(!o2.cards.some((c) => c.type === 'declining-clicks'));
  const o3 = findOpportunities(result({ prev: { clicks: 310, impressions: 12000, position: 8 } }));
  assert.ok(!o3.cards.some((c) => c.type === 'declining-clicks'));
});

test('"newly visible" is suppressed when previous rows were truncated or absent', () => {
  const rows = [{ query: 'fresh', clicks: 1, impressions: 200, position: 30 }];
  const prevRows = [{ query: 'old', clicks: 1, impressions: 100, position: 30 }];
  assert.ok(findOpportunities(result({ rows, prevRows })).cards.some((c) => c.type === 'newly-visible'));
  assert.ok(!findOpportunities(result({ rows, prevRows, truncated: true })).cards.some((c) => c.type === 'newly-visible'));
  assert.ok(!findOpportunities(result({ rows, prevRows: [] })).cards.some((c) => c.type === 'newly-visible'));
  const card = findOpportunities(result({ rows, prevRows })).cards.find((c) => c.type === 'newly-visible');
  assert.doesNotMatch(card.title, /\bnew\b/i);
  assert.match(card.caveats[0], /may have had impressions before/);
});

test('thresholds are configurable', () => {
  const t = mergeThresholds({ minPageImpressions: 10, lowCtr: { minImpressions: 5 } });
  assert.equal(t.minPageImpressions, 10);
  assert.equal(t.lowCtr.minImpressions, 5);
  assert.equal(t.lowCtr.maxPosition, DEFAULT_THRESHOLDS.lowCtr.maxPosition);
});

test('page totals are not derived from query rows; partial coverage is warned', () => {
  const r = result({ rows: [{ query: 'a', clicks: 100, impressions: 1000, position: 2 }] });
  assert.equal(r.summary.current.clicks, 300);
  assert.ok(r.warnings.some((w) => w.code === 'partial-query-coverage'));
});

test('brief contains URL, provider, dates, evidence, checks, questions and follow-up', () => {
  const rows = [{ query: 'low', clicks: 5, impressions: 1000, position: 3 }];
  const r = result({ rows, prevRows: rows });
  const o = findOpportunities(r);
  const b = buildBrief({ result: r, selectedQueries: ['low'], selectedCards: o.cards.slice(0, 2) });
  for (const s of ['https://example.com/page', 'Google Search Console', 'Oct 9, 2026', 'Sep 11, 2026', '“low”',
    'Questions for the author', 'Follow-up', 'Suggested checks', 'pp']) {
    assert.ok(b.markdown.includes(s), `markdown missing ${s}`);
    assert.ok(b.text.toLowerCase().includes(s.toLowerCase()), `text missing ${s}`);
  }
  assert.ok(b.markdown.startsWith('# Editing brief'));
  assert.match(b.markdown, /do not guarantee/);
  // Phrased as checks because content was not inspected.
  assert.ok(!b.markdown.includes('Suggested editing tasks'));
});

test('brief without comparison says so', () => {
  const r = result({ comparable: false, rows: [{ query: 'q', clicks: 1, impressions: 200, position: 5 }] });
  const b = buildBrief({ result: r, selectedQueries: ['q'] });
  assert.match(b.markdown, /## What changed\n\n- none/);
});

test('Workspace AI prompt includes selected evidence without generic brief sections', () => {
  const rows = [
    { query: 'selected query', clicks: 5, impressions: 1000, position: 3 },
    { query: 'unselected query', clicks: 8, impressions: 500, position: 4 },
  ];
  const r = result({ rows, prevRows: rows });
  const card = findOpportunities(r).cards.find((c) => c.queries.includes('selected query'));
  const b = buildBrief({ result: r, selectedQueries: [], selectedCards: [card] });
  const prompt = buildWorkspacePrompt(b);
  assert.match(prompt, /https:\/\/example\.com\/page/);
  assert.match(prompt, /selected query/);
  assert.doesNotMatch(prompt, /unselected query/);
  assert.match(prompt, /## Suggested checks/);
  assert.match(prompt, /## Caveats/);
  assert.doesNotMatch(prompt, /Questions for the author|Follow-up|Editing brief/);
  assert.match(prompt, /only where supported by the selected queries and checks/);
  assert.match(prompt, /Ask before changing or replacing document content/);
  assert.match(prompt, /Do not invent causes for performance changes or promise ranking gains/);
});

test('Workspace AI prompt distinguishes selected queries from suggestion evidence', () => {
  const rows = [
    { query: 'suggestion query', clicks: 5, impressions: 1000, position: 3 },
    { query: 'selected query', clicks: 8, impressions: 500, position: 4 },
  ];
  const r = result({ rows, prevRows: rows });
  const card = findOpportunities(r).cards.find((c) => c.type === 'low-ctr');
  const prompt = buildWorkspacePrompt(buildBrief({
    result: r, selectedQueries: ['selected query'], selectedCards: [card],
  }));
  assert.match(prompt, /## Selected queries\n- “selected query”/);
  assert.match(prompt, /## Queries from selected suggestions\n- “suggestion query”/);

  const withoutSelection = buildWorkspacePrompt(buildBrief({ result: r, selectedCards: [card] }));
  assert.doesNotMatch(withoutSelection, /selected query/);
  assert.match(withoutSelection, /## Queries from selected suggestions\n- “suggestion query”/);

  const overlapping = buildBrief({ result: r, selectedQueries: ['suggestion query'], selectedCards: [card] });
  assert.equal(overlapping.queryCount, 1);
  assert.ok(!overlapping.sections.some((section) => section.heading === 'Queries from selected suggestions'));
});

test('brief HTML escapes untrusted query text', () => {
  const r = result({ rows: [{ query: '<img src=x onerror=alert(1)>', clicks: 1, impressions: 200, position: 5 }] });
  const html = briefToHtml(buildBrief({ result: r, selectedQueries: ['<img src=x onerror=alert(1)>'] }));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});
