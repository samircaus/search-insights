/**
 * Platform-independent request handler. `index.js` adapts it to Cloudflare
 * Workers; another host (e.g. Adobe App Builder) can call `handle()` with its
 * own store and fetch implementation.
 */
import { AppError, errorBody } from './errors.js';
import { log, redact } from './redact.js';
import {
  loadSites, requireSite, providerStatus, publicSiteConfig,
} from './config.js';
import { authenticate } from './adobe-auth.js';
import {
  startAuthorization, consumeState, exchangeCode, getAccessToken, disconnect, tokenKey,
} from './oauth.js';
import {
  googleClient, googleReport, accessibleProperties, googleInspection,
} from './providers/google.js';
import { bingClient, bingReport } from './providers/bing.js';
import { checkPublishedPage } from './page-check.js';
import { secureStore } from './store.js';
import { sha256, randomToken } from './crypto.js';
import { validateOverride, isUrlInGoogleProperty } from '../web/core/url-resolver.js';

const REPORT_TTL = 900;
const INSPECTION_TTL = 3600;
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function q(url, name) {
  const v = url.searchParams.get(name);
  return v === null ? null : v.slice(0, 2048);
}

/** Same-origin only: reject browser requests from other origins (no CORS is offered). */
function checkOrigin(request, url) {
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) throw new AppError('UNAUTHENTICATED', `origin ${origin}`);
  const site = request.headers.get('sec-fetch-site');
  if (site && !['same-origin', 'none'].includes(site)) throw new AppError('UNAUTHENTICATED', `sec-fetch-site ${site}`);
}

async function ctxFor(request, url, deps) {
  checkOrigin(request, url);
  const sites = loadSites(deps.env);
  const site = requireSite(sites, q(url, 'org'), q(url, 'site'));
  const auth = await authenticate(request, site, { env: deps.env, store: deps.store, fetchImpl: deps.fetchImpl });
  return { site, auth };
}

function resolveRequestedUrl(url, site) {
  const v = validateOverride(q(url, 'url') || '', site);
  if (!v.ok) throw new AppError('URL_NOT_ALLOWED', v.reason);
  return v.url;
}

function days(url, site) {
  const d = Number(q(url, 'days') || site.reportingDays || 28);
  if (![7, 28, 90].includes(d)) throw new AppError('BAD_REQUEST', 'days must be 7, 28 or 90');
  return d;
}

async function connectionInfo(provider, site, userId, deps, secure) {
  const status = providerStatus(site, deps.env)[provider];
  if (!status.enabled) return { ...status, connected: false };
  if (provider === 'bing' && site.bing.auth === 'apiKey') {
    return { ...status, connected: status.configured, account: status.configured ? 'Deployment API key' : null };
  }
  const tok = await secure.get(tokenKey(provider, userId));
  return {
    ...status,
    connected: !!tok?.refreshToken,
    account: tok?.account || null,
    connectedAt: tok?.connectedAt || null,
  };
}

async function cached(secure, key, fn, ttl = REPORT_TTL) {
  const hit = await secure.get(key);
  if (hit) return { ...hit, cache: 'hit' };
  const value = await fn();
  await secure.put(key, value, { ttl });
  return { ...value, cache: 'miss' };
}

function googleProperty(url, site, pageUrl) {
  if (!site.google) throw new AppError('NOT_CONFIGURED', 'google');
  const property = q(url, 'property') || site.google.properties[0];
  if (!site.google.properties.includes(property)) throw new AppError('URL_NOT_ALLOWED', 'property not allowed');
  if (!isUrlInGoogleProperty(pageUrl, property)) throw new AppError('URL_NOT_ALLOWED', 'url outside property');
  return property;
}

async function handleInspection(request, url, deps, secure) {
  const { site, auth } = await ctxFor(request, url, deps);
  const pageUrl = resolveRequestedUrl(url, site);
  const property = googleProperty(url, site, pageUrl);
  const accessToken = await getAccessToken({
    provider: 'google', userId: auth.userId, env: deps.env, secure, fetchImpl: deps.fetchImpl,
  });
  const key = `cache:v1:inspect:${auth.userId}:${property}:${await sha256(pageUrl)}`;
  if (q(url, 'refresh') === '1') await secure.delete(key);
  const client = googleClient({ accessToken, fetchImpl: deps.fetchImpl });
  return cached(secure, key, () => googleInspection({ client, property, url: pageUrl }), INSPECTION_TTL);
}

async function handleReport(request, url, deps, secure) {
  const { site, auth } = await ctxFor(request, url, deps);
  const provider = q(url, 'provider');
  const pageUrl = resolveRequestedUrl(url, site);
  const nDays = days(url, site);
  const urlHash = await sha256(pageUrl);
  const fresh = q(url, 'refresh') === '1';

  if (provider === 'google') {
    const property = googleProperty(url, site, pageUrl);
    const accessToken = await getAccessToken({
      provider: 'google', userId: auth.userId, env: deps.env, secure, fetchImpl: deps.fetchImpl,
    });
    const key = `cache:v1:google:${auth.userId}:${property}:${urlHash}:${nDays}`;
    if (fresh) await secure.delete(key);
    const client = googleClient({ accessToken, fetchImpl: deps.fetchImpl });
    return cached(secure, key, () => googleReport({
      client, property, url: pageUrl, days: nDays, maxRows: site.google.maxQueryRows || 1000,
    }));
  }

  if (provider === 'bing') {
    if (!site.bing) throw new AppError('NOT_CONFIGURED', 'bing');
    let client;
    let principal;
    if (site.bing.auth === 'apiKey') {
      if (!deps.env.BING_API_KEY) throw new AppError('NOT_CONFIGURED', 'bing api key');
      client = bingClient({ apiKey: deps.env.BING_API_KEY, fetchImpl: deps.fetchImpl });
      // Deployment-owned key: data is shared by all authorized authors of this site.
      principal = `site:${site.id}`;
    } else {
      const accessToken = await getAccessToken({
        provider: 'bing', userId: auth.userId, env: deps.env, secure, fetchImpl: deps.fetchImpl,
      });
      client = bingClient({ accessToken, fetchImpl: deps.fetchImpl });
      principal = auth.userId;
    }
    const key = `cache:v1:bing:${principal}:${site.bing.siteUrl}:${urlHash}:${nDays}`;
    if (fresh) await secure.delete(key);
    return cached(secure, key, () => bingReport({
      client, siteUrl: site.bing.siteUrl, url: pageUrl, days: nDays,
    }));
  }
  throw new AppError('BAD_REQUEST', 'unknown provider');
}

function callbackPage({ ok, provider, message }) {
  const nonce = randomToken(16);
  const label = provider === 'bing' ? 'Bing Webmaster Tools' : 'Google Search Console';
  const safe = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Search Insights</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1d1d1f;background:#fff}
h1{font-size:1.25rem}</style></head><body>
<h1>${ok ? `${safe(label)} connected` : 'Connection not completed'}</h1>
<p>${safe(message)}</p><p>You can close this window and return to Experience Workspace.</p>
<script nonce="${nonce}">${ok ? 'setTimeout(function(){window.close()},1200);' : ''}</script>
</body></html>`;
  return new Response(body, {
    status: ok ? 200 : 400,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors 'none'`,
    },
  });
}

async function handleCallback(provider, url, deps, secure) {
  const error = q(url, 'error');
  const state = q(url, 'state');
  try {
    const record = await consumeState({ provider, state, store: secure });
    if (error) {
      return callbackPage({ ok: false, provider, message: error === 'access_denied' ? 'Access was not granted.' : 'The provider returned an error.' });
    }
    const code = q(url, 'code');
    if (!code) throw new AppError('BAD_REQUEST', 'missing code');
    const tokens = await exchangeCode({
      provider, code, record, env: deps.env, requestUrl: url.href, fetchImpl: deps.fetchImpl,
    });
    await secure.put(tokenKey(provider, record.userId), {
      refreshToken: tokens.refreshToken,
      account: tokens.account,
      scope: tokens.scope,
      connectedAt: new Date().toISOString(),
    });
    await secure.put(`atok:${provider}:${record.userId}`, {
      accessToken: tokens.accessToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    }, { ttl: Math.max(60, tokens.expiresIn - 120) });
    log('info', 'provider connected', { provider, site: record.siteId });
    return callbackPage({ ok: true, provider, message: tokens.account ? `Connected as ${tokens.account}.` : 'Connected.' });
  } catch (e) {
    log('warn', 'oauth callback failed', { provider, code: e.code, detail: e.detail });
    return callbackPage({ ok: false, provider, message: e instanceof AppError ? e.message : 'Unexpected error.' });
  }
}

export async function handle(request, deps) {
  const url = new URL(request.url);
  const secret = deps.env.TOKEN_ENCRYPTION_KEY;
  const secure = secureStore(deps.store, secret);
  const { pathname } = url;
  try {
    if (pathname === '/api/health') {
      return json({ ok: true, encryptionKey: !!secret });
    }
    if (!secret) throw new AppError('INTERNAL', 'TOKEN_ENCRYPTION_KEY missing');

    const cb = /^\/oauth\/(google|bing)\/callback$/.exec(pathname);
    if (cb && request.method === 'GET') return handleCallback(cb[1], url, deps, secure);

    if (pathname === '/api/config' && request.method === 'GET') {
      const { site, auth } = await ctxFor(request, url, deps);
      return json({
        site: publicSiteConfig(site),
        providers: providerStatus(site, deps.env),
        user: { id: auth.userId },
      });
    }

    if (pathname === '/api/status' && request.method === 'GET') {
      const { site, auth } = await ctxFor(request, url, deps);
      const [google, bing] = await Promise.all([
        connectionInfo('google', site, auth.userId, deps, secure),
        connectionInfo('bing', site, auth.userId, deps, secure),
      ]);
      return json({ google, bing });
    }

    const start = /^\/api\/oauth\/(google|bing)\/start$/.exec(pathname);
    if (start && request.method === 'POST') {
      const { site, auth } = await ctxFor(request, url, deps);
      const provider = start[1];
      if (!site[provider]) throw new AppError('NOT_CONFIGURED', provider);
      if (provider === 'bing' && site.bing.auth !== 'oauth') throw new AppError('NOT_CONFIGURED', 'bing uses api key');
      return json(await startAuthorization({
        provider, userId: auth.userId, siteId: site.id, env: deps.env, store: secure, requestUrl: url.href,
      }));
    }

    const disc = /^\/api\/oauth\/(google|bing)\/disconnect$/.exec(pathname);
    if (disc && request.method === 'POST') {
      const { auth } = await ctxFor(request, url, deps);
      return json(await disconnect({
        provider: disc[1], userId: auth.userId, secure, fetchImpl: deps.fetchImpl,
      }));
    }

    if (pathname === '/api/google/properties' && request.method === 'GET') {
      const { site, auth } = await ctxFor(request, url, deps);
      if (!site.google) throw new AppError('NOT_CONFIGURED', 'google');
      const accessToken = await getAccessToken({
        provider: 'google', userId: auth.userId, env: deps.env, secure, fetchImpl: deps.fetchImpl,
      });
      const props = await accessibleProperties(googleClient({ accessToken, fetchImpl: deps.fetchImpl }), site.google.properties);
      return json({ properties: props });
    }

    if (pathname === '/api/report' && request.method === 'GET') {
      return json(await handleReport(request, url, deps, secure));
    }

    if (pathname === '/api/google/inspect' && request.method === 'GET') {
      return json(await handleInspection(request, url, deps, secure));
    }

    if (pathname === '/api/page-check' && request.method === 'GET') {
      const { site } = await ctxFor(request, url, deps);
      return json(await checkPublishedPage(q(url, 'url') || '', site, { fetchImpl: deps.fetchImpl }));
    }

    if (pathname.startsWith('/api/')) throw new AppError('BAD_REQUEST', 'unknown endpoint');
    return null; // not an API route
  } catch (e) {
    if (e instanceof AppError) {
      log(e.status >= 500 ? 'error' : 'warn', 'request failed', { path: pathname, code: e.code, detail: e.detail });
      return json(errorBody(e), e.status);
    }
    log('error', 'unhandled', { path: pathname, error: redact(e?.stack || String(e)) });
    return json(errorBody(e), 500);
  }
}
