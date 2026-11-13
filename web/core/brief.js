/**
 * Deterministic editing brief. Works without any AI service.
 *
 * Built only from evidence the author selected. When page content has not been
 * inspected, recommendations are phrased as checks, not claims.
 */

import {
  fmtInt, fmtPct, fmtPos, fmtRelChange, fmtPp, fmtPosChange, isNum,
} from './metrics.js';
import { fmtRange, addDays, fmtDate } from './dates.js';
import { inspectionBriefLines, inspectionChecks } from './inspection.js';

const PROVIDER_LABEL = { google: 'Google Search Console', bing: 'Bing Webmaster Tools' };

function queryLine(row) {
  const c = row.current;
  const parts = [
    `${fmtInt(c.impressions)} impressions`,
    `${fmtInt(c.clicks)} clicks`,
    `CTR ${fmtPct(c.ctr)}`,
  ];
  if (isNum(c.position)) parts.push(`avg. position ${fmtPos(c.position)}`);
  let prev = '';
  if (row.previousStatus === 'present') {
    prev = ` (previous period: ${fmtInt(row.previous.clicks)} clicks, ${fmtInt(row.previous.impressions)} impressions`
      + `${isNum(row.previous.position) ? `, position ${fmtPos(row.previous.position)}` : ''})`;
  } else if (row.previousStatus === 'not-in-returned-rows') {
    prev = ' (not among the rows returned for the previous period)';
  }
  return `“${row.query}” — ${parts.join(', ')}${prev}`;
}

function uniq(arr) {
  return [...new Set(arr)];
}

/**
 * @param {object} p
 * @param {object} p.result normalized provider result
 * @param {string[]} p.selectedQueries query strings selected in the table
 * @param {object[]} p.selectedCards opportunity cards selected
 * @param {number} [p.followUpDays=28]
 * @param {boolean} [p.contentInspected=false]
 */
export function buildBrief({
  result, selectedQueries = [], selectedCards = [], followUpDays = 28, contentInspected = false, inspection = null,
}) {
  const provider = PROVIDER_LABEL[result.provider] || result.provider;
  const p = result.periods || {};
  const s = result.summary;
  const rowsByQuery = new Map(result.queries.map((r) => [r.query, r]));
  const explicitQueries = uniq(selectedQueries)
    .map((q) => rowsByQuery.get(q))
    .filter(Boolean);
  const explicitNames = new Set(explicitQueries.map((row) => row.query));
  const relatedQueries = uniq(selectedCards.flatMap((c) => c.queries || []))
    .filter((q) => !explicitNames.has(q))
    .map((q) => rowsByQuery.get(q))
    .filter(Boolean);
  const queries = [...explicitQueries, ...relatedQueries];

  const sections = [];
  sections.push({
    heading: 'Page',
    lines: [
      `URL: ${result.requestedUrl}`,
      ...(result.reportedUrl && result.reportedUrl !== result.requestedUrl ? [`Reported as: ${result.reportedUrl}`] : []),
      `Source: ${provider}${result.property ? ` (${result.property})` : ''}`,
      `Period: ${fmtRange(p.current)}${p.previous ? `, compared with ${fmtRange(p.previous)}` : ' (no comparison period available)'}`,
      ...(result.freshness?.note ? [`Data freshness: ${result.freshness.note}`] : []),
      ...inspectionBriefLines(inspection),
    ],
  });

  const perf = [
    `Clicks: ${fmtInt(s.current.clicks)}`,
    `Impressions: ${fmtInt(s.current.impressions)}`,
    `CTR: ${fmtPct(s.current.ctr)}`,
  ];
  if (isNum(s.current.position)) perf.push(`Average position: ${fmtPos(s.current.position)}`);
  sections.push({ heading: 'Page performance', lines: perf });

  if (result.comparison?.available && s.previous) {
    const ch = s.change;
    sections.push({
      heading: 'What changed',
      lines: [
        `Clicks: ${fmtInt(s.previous.clicks)} → ${fmtInt(s.current.clicks)} (${fmtRelChange(ch.clicks)})`,
        `Impressions: ${fmtInt(s.previous.impressions)} → ${fmtInt(s.current.impressions)} (${fmtRelChange(ch.impressions)})`,
        `CTR: ${fmtPct(s.previous.ctr)} → ${fmtPct(s.current.ctr)} (${fmtPp(ch.ctrPp)})`,
        ...(ch.position ? [`Average position: ${fmtPos(s.previous.position)} → ${fmtPos(s.current.position)} (${fmtPosChange(ch.position)})`] : []),
        'These are observed changes; they do not by themselves explain why traffic changed.',
      ],
    });
  } else {
    sections.push({
      heading: 'What changed',
      lines: [result.comparison?.reason || 'No valid comparison period is available, so changes are not reported.'],
    });
  }

  if (explicitQueries.length) {
    sections.push({ heading: 'Selected queries', lines: explicitQueries.map(queryLine) });
  }
  if (relatedQueries.length) {
    sections.push({ heading: 'Queries from selected suggestions', lines: relatedQueries.map(queryLine) });
  }

  if (selectedCards.length) {
    sections.push({
      heading: 'Flagged items',
      lines: selectedCards.map((c) => `${c.title}: ${c.why}`),
    });
  }

  const checks = uniq([...inspectionChecks(inspection), ...selectedCards.flatMap((c) => c.checks || [])]);
  if (!checks.length && queries.length) {
    queries.forEach((r) => {
      checks.push(`Read the page as someone searching “${r.query}” and check whether it answers that need clearly.`);
    });
    checks.push('Check that the title and meta description describe what the page actually offers.');
  }
  if (checks.length) {
    sections.push({
      heading: contentInspected ? 'Suggested editing tasks' : 'Suggested checks',
      lines: checks,
    });
  }

  const questions = [
    'Who is this page for, and which of the selected queries match that audience?',
    'Does the first screen of the page answer the main query directly?',
    ...(queries.length ? ['Is there a query here the page should not try to serve? If so, leave it alone.'] : []),
    'Did anything change on the page or the site between the two periods?',
  ];
  sections.push({ heading: 'Questions for the author', lines: questions });

  const followUpDate = p.current?.end ? fmtDate(addDays(p.current.end, followUpDays)) : null;
  const caveats = uniq([
    ...selectedCards.flatMap((c) => c.caveats || []),
    `${provider} returns top rows only and omits some queries; the query list is not complete keyword coverage.`,
    ...(result.warnings || []).map((w) => w.message),
  ]);
  sections.push({ heading: 'Caveats', lines: caveats });
  sections.push({
    heading: 'Follow-up',
    lines: [
      `After making changes, wait for at least ${followUpDays} days of new data${followUpDate ? ` (around ${followUpDate})` : ''} and compare the same queries again.`,
      'Edits do not guarantee ranking or traffic changes.',
    ],
  });

  const title = `Editing brief: ${result.requestedUrl}`;
  const markdown = [`# ${title}`, '']
    .concat(...sections.map((sec) => [`## ${sec.heading}`, '', ...sec.lines.map((l) => `- ${l}`), '']))
    .join('\n').trim();
  const text = [title, '='.repeat(Math.min(title.length, 60)), '']
    .concat(...sections.map((sec) => [sec.heading.toUpperCase(), ...sec.lines.map((l) => `• ${l}`), '']))
    .join('\n').trim();
  return { title, sections, markdown, text, queryCount: queries.length };
}

export function buildWorkspacePrompt(brief) {
  const evidence = brief.sections
    .filter((section) => section.heading !== 'Questions for the author' && section.heading !== 'Follow-up')
    .flatMap((section) => [`## ${section.heading}`, ...section.lines.map((line) => `- ${line}`), '']);
  return [
    'Use these Search Insights results as evidence when helping me improve the page.',
    'Suggest specific edits only where supported by the selected queries and checks.',
    'Do not invent causes for performance changes or promise ranking gains.',
    'Ask before changing or replacing document content.',
    '',
    ...evidence,
  ].join('\n').trim();
}

/** Escape text for safe insertion as HTML. */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** HTML version of a brief for explicit insertion into the document. All text escaped. */
export function briefToHtml(brief) {
  const parts = [`<h2>${escapeHtml(brief.title)}</h2>`];
  for (const sec of brief.sections) {
    parts.push(`<h3>${escapeHtml(sec.heading)}</h3>`);
    parts.push(`<ul>${sec.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`);
  }
  return parts.join('');
}

