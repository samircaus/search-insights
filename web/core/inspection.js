/**
 * Normalize a Google URL Inspection API result (urlInspection.index.inspect).
 * Verified fields: https://developers.google.com/webmaster-tools/v1/urlInspection.index/UrlInspectionResult
 *
 * The API reports the version in Google's index, not the live page. Findings
 * are phrased as observations from Google plus checks, never as guarantees.
 */

const FETCH_TEXT = {
  SOFT_404: 'Google treated the page as a soft 404 (it looked like an error or empty page).',
  BLOCKED_ROBOTS_TXT: 'Google could not fetch the page because robots.txt blocks it.',
  NOT_FOUND: 'Google received a 404 (not found) when fetching the page.',
  ACCESS_DENIED: 'Google was denied access (401) when fetching the page.',
  SERVER_ERROR: 'Google received a server error (5xx) when fetching the page.',
  REDIRECT_ERROR: 'Google hit a redirect error when fetching the page.',
  ACCESS_FORBIDDEN: 'Google was forbidden (403) when fetching the page.',
  BLOCKED_4XX: 'Google received a 4xx error when fetching the page.',
  INTERNAL_CRAWL_ERROR: 'Google reported an internal crawl error.',
  INVALID_URL: 'Google considers the URL invalid.',
};

function sameUrl(a, b) {
  if (!a || !b) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && decodeURIComponent(x.pathname) === decodeURIComponent(y.pathname) && x.search === y.search;
  } catch {
    return a === b;
  }
}

function daysBetween(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86400000);
}

/**
 * @param {object} raw  the `inspectionResult` object from the API
 * @param {{url:string, property:string, inspectedAt?:string, now?:number}} meta
 */
export function normalizeInspection(raw, { url, property, inspectedAt, now = Date.now() }) {
  const idx = raw?.indexStatusResult || {};
  const findings = [];
  const verdict = idx.verdict || 'VERDICT_UNSPECIFIED';

  let status = 'unknown';
  if (verdict === 'PASS') status = 'indexed';
  else if (verdict === 'FAIL') status = 'error';
  else if (verdict === 'NEUTRAL') status = 'excluded';

  const coverage = idx.coverageState || null;
  if (status === 'indexed') {
    findings.push({ level: 'ok', code: 'indexed', message: `Google reports this URL is indexed${coverage ? ` (“${coverage}”)` : ''}.` });
  } else if (status === 'excluded' || status === 'error') {
    findings.push({
      level: status === 'error' ? 'error' : 'warn',
      code: 'not-indexed',
      message: `Google reports this URL is not indexed${coverage ? `: “${coverage}”` : ''}. Search data for this URL will be missing or limited until it is indexed.`,
    });
  }

  if (idx.indexingState === 'BLOCKED_BY_META_TAG' || idx.indexingState === 'BLOCKED_BY_HTTP_HEADER') {
    findings.push({
      level: 'error',
      code: 'noindex',
      message: `Google found a noindex rule in the ${idx.indexingState === 'BLOCKED_BY_META_TAG' ? 'robots meta tag' : 'X-Robots-Tag header'}. Check whether this is intended (for example page metadata “robots: noindex”).`,
    });
  }
  if (idx.robotsTxtState === 'DISALLOWED') {
    findings.push({ level: 'error', code: 'robots-disallowed', message: 'robots.txt blocks Google from crawling this URL.' });
  }
  if (idx.pageFetchState && FETCH_TEXT[idx.pageFetchState]) {
    findings.push({ level: 'error', code: `fetch-${idx.pageFetchState.toLowerCase()}`, message: FETCH_TEXT[idx.pageFetchState] });
  }

  const googleCanonical = idx.googleCanonical || null;
  const userCanonical = idx.userCanonical || null;
  let canonical = 'unknown';
  if (googleCanonical) {
    if (sameUrl(googleCanonical, url)) canonical = 'self';
    else canonical = 'other';
  }
  if (canonical === 'other') {
    findings.push({
      level: 'warn',
      code: 'google-canonical-differs',
      message: `Google selected a different canonical URL: ${googleCanonical}${userCanonical ? ` (the page declares ${userCanonical})` : ''}. Google usually reports search data under its selected canonical.`,
      canonical: googleCanonical,
    });
  } else if (userCanonical && !sameUrl(userCanonical, url)) {
    findings.push({
      level: 'warn',
      code: 'user-canonical-differs',
      message: `The page declares a different canonical URL: ${userCanonical}.`,
      canonical: userCanonical,
    });
  }

  const lastCrawlDays = idx.lastCrawlTime ? daysBetween(idx.lastCrawlTime, now) : null;
  if (!idx.lastCrawlTime && status !== 'indexed') {
    findings.push({ level: 'info', code: 'never-crawled', message: 'Google has no successful crawl of this URL on record.' });
  }

  const rich = raw?.richResultsResult;
  const richResults = rich ? {
    verdict: rich.verdict || null,
    types: (rich.detectedItems || []).map((d) => {
      const issues = (d.items || []).flatMap((it) => (it.issues || []).map((i) => ({
        item: it.name || null, message: i.issueMessage, severity: i.severity,
      })));
      return {
        type: d.richResultType,
        items: (d.items || []).length,
        errors: issues.filter((i) => i.severity === 'ERROR').length,
        warnings: issues.filter((i) => i.severity === 'WARNING').length,
        issues,
      };
    }),
  } : null;
  if (richResults?.types.some((t) => t.errors > 0)) {
    findings.push({
      level: 'warn',
      code: 'rich-results-errors',
      message: `Structured data errors: ${richResults.types.filter((t) => t.errors).map((t) => `${t.type} (${t.errors})`).join(', ')}. Items with errors cannot appear as rich results.`,
    });
  }

  return {
    url,
    property,
    inspectedAt: inspectedAt || new Date(now).toISOString(),
    source: 'Google index (not a live test)',
    link: raw?.inspectionResultLink || null,
    status,
    verdict,
    coverageState: coverage,
    indexingState: idx.indexingState || null,
    robotsTxtState: idx.robotsTxtState || null,
    pageFetchState: idx.pageFetchState || null,
    crawledAs: idx.crawledAs || null,
    lastCrawlTime: idx.lastCrawlTime || null,
    lastCrawlDays,
    googleCanonical,
    userCanonical,
    canonical,
    sitemaps: idx.sitemap || [],
    referringUrlCount: (idx.referringUrls || []).length,
    richResults,
    findings,
  };
}

export function inspectionHeadline(i) {
  switch (i?.status) {
    case 'indexed': return 'Indexed by Google';
    case 'excluded': return 'Not indexed (excluded)';
    case 'error': return 'Not indexed (error)';
    default: return 'Index status unknown';
  }
}

/** Lines for the editing brief. */
export function inspectionBriefLines(i) {
  if (!i) return [];
  const lines = [`Google index status (inspected ${i.inspectedAt.slice(0, 10)}; reflects Google's indexed version): ${inspectionHeadline(i)}${i.coverageState ? ` – ${i.coverageState}` : ''}`];
  if (i.lastCrawlTime) lines.push(`Last crawled by Google: ${i.lastCrawlTime.slice(0, 10)}${i.crawledAs ? ` (${i.crawledAs.toLowerCase()} crawler)` : ''}`);
  if (i.googleCanonical) lines.push(`Google-selected canonical: ${i.googleCanonical}${i.canonical === 'self' ? ' (this URL)' : ''}`);
  return lines;
}

export function inspectionChecks(i) {
  if (!i) return [];
  return i.findings.filter((f) => f.level === 'error' || f.level === 'warn').map((f) => `Index status: ${f.message}`);
}
