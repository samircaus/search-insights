/**
 * Fetch the published page to read its canonical link and status.
 *
 * Guardrails against arbitrary outbound fetching:
 *  - Only URLs on the configured production origin (validated by validateOverride).
 *  - Redirects are followed manually (max 3) and each hop must stay on that origin.
 *  - GET only, no credentials, 5 s timeout, at most 1 MB read.
 */
import { validateOverride, compareCanonical } from '../web/core/url-resolver.js';
import { AppError } from './errors.js';

const MAX_BYTES = 1_000_000;

export function extractCanonical(html) {
  const links = html.match(/<link\b[^>]*>/gi) || [];
  for (const tag of links) {
    if (/\brel\s*=\s*["']?canonical["'\s>]/i.test(tag)) {
      const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
      if (m) return (m[1] ?? m[2] ?? m[3]).replace(/&amp;/g, '&');
    }
  }
  return null;
}

async function readLimited(resp) {
  const reader = resp.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    if (total >= MAX_BYTES) { await reader.cancel(); break; }
  }
  const buf = new Uint8Array(Math.min(total, MAX_BYTES));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, buf.length - off);
    buf.set(c.subarray(0, take), off);
    off += take;
    if (off >= buf.length) break;
  }
  return new TextDecoder().decode(buf);
}

export async function checkPublishedPage(inputUrl, site, { fetchImpl = fetch } = {}) {
  const v = validateOverride(inputUrl, site);
  if (!v.ok) throw new AppError('URL_NOT_ALLOWED', v.reason);
  let current = v.url;
  const origin = new URL(v.url).origin;
  const hops = [];
  for (let i = 0; i < 4; i += 1) {
    let resp;
    try {
      // eslint-disable-next-line no-await-in-loop
      resp = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html', 'user-agent': 'SearchInsights-PageCheck/1.0' },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return { url: v.url, status: 'unreachable', hops };
    }
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get('location');
      if (!loc) return { url: v.url, status: 'bad-redirect', hops };
      const next = new URL(loc, current);
      hops.push({ status: resp.status, to: next.href });
      if (next.origin !== origin) {
        return { url: v.url, status: 'redirects-off-site', hops };
      }
      current = next.href;
      // eslint-disable-next-line no-continue
      continue;
    }
    if (resp.status === 404) return { url: v.url, status: 'not-found', hops };
    if (!resp.ok) return { url: v.url, status: `http-${resp.status}`, hops };
    const type = resp.headers.get('content-type') || '';
    if (!type.includes('text/html')) return { url: v.url, status: 'not-html', hops };
    // eslint-disable-next-line no-await-in-loop
    const html = await readLimited(resp);
    const canonical = compareCanonical(validateOverride(current, site).url, extractCanonical(html), site);
    return {
      url: v.url,
      finalUrl: validateOverride(current, site).url,
      status: 'ok',
      redirected: hops.length > 0,
      canonical,
      hops,
    };
  }
  return { url: v.url, status: 'too-many-redirects', hops };
}
