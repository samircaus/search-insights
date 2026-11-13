import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../worker/app.js';
import { memoryStore, secureStore } from '../worker/store.js';
import { startAuthorization, consumeState, getAccessToken, tokenKey, exchangeCode } from '../worker/oauth.js';
import { redact } from '../worker/redact.js';
import { extractCanonical, checkPublishedPage } from '../worker/page-check.js';
import { encryptJson, decryptJson } from '../worker/crypto.js';
import { validateSite } from '../worker/config.js';

const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'; // 32 bytes, test only
const SITE = {
  id: 'edgepatterns',
  da: { org: 'samircaus', site: 'da-elsie' },
  productionOrigin: 'https://edgepatterns.dev',
  google: { properties: ['sc-domain:edgepatterns.dev'] },
  bing: { siteUrl: 'https://edgepatterns.dev/', auth: 'apiKey' },
};
const ENV = {
  SITES: { sites: [SITE] },
  TOKEN_ENCRYPTION_KEY: KEY,
  GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'gsecret',
  BING_API_KEY: 'bingkey',
  IMS_CLIENT_IDS: 'darkalley',
};
const IMS_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJ1c2VyX2lkIjoiVTFAQWRvYmVJRCJ9.signaturesignature';

function fakeFetch({ imsValid = true, daStatus = 200, userId = 'U1@AdobeID' } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.startsWith('https://ims-na1.adobelogin.com/ims/validate_token/v1')) {
      return Response.json(imsValid ? { valid: true, token: { user_id: userId, client_id: 'darkalley' } } : { valid: false, reason: 'bad_signature' });
    }
    if (u.startsWith('https://admin.da.live/list/')) return new Response('[]', { status: daStatus });
    if (u.startsWith('https://ssl.bing.com/')) return Response.json({ d: [] });
    throw new Error(`unexpected fetch ${u}`);
  };
  fn.calls = calls;
  return fn;
}

function req(path, { token = IMS_TOKEN, method = 'GET', headers = {} } = {}) {
  return new Request(`https://si.example.workers.dev${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
}

test('requests without a Workspace token are rejected', async () => {
  const res = await handle(req('/api/config?org=samircaus&site=da-elsie', { token: null }), { env: ENV, store: memoryStore(), fetchImpl: fakeFetch() });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'UNAUTHENTICATED');
});

test('token rejected by Adobe IMS is not trusted even if it decodes', async () => {
  const res = await handle(req('/api/config?org=samircaus&site=da-elsie'), { env: ENV, store: memoryStore(), fetchImpl: fakeFetch({ imsValid: false }) });
  assert.equal(res.status, 401);
});

test('user without DA access to the site is forbidden', async () => {
  const res = await handle(req('/api/config?org=samircaus&site=da-elsie'), { env: ENV, store: memoryStore(), fetchImpl: fakeFetch({ daStatus: 403 }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'FORBIDDEN_SITE');
});

test('unconfigured sites are forbidden (public site id is not authorization)', async () => {
  const res = await handle(req('/api/config?org=other&site=x'), { env: ENV, store: memoryStore(), fetchImpl: fakeFetch() });
  assert.equal(res.status, 403);
});

test('allowlist restricts IMS users when configured', async () => {
  const env = { ...ENV, SITES: { sites: [{ ...SITE, access: { allowedUserIds: ['SOMEONE@AdobeID'] } }] } };
  const res = await handle(req('/api/config?org=samircaus&site=da-elsie'), { env, store: memoryStore(), fetchImpl: fakeFetch() });
  assert.equal(res.status, 403);
});

test('cross-origin browser requests are rejected (no CORS)', async () => {
  const res = await handle(req('/api/config?org=samircaus&site=da-elsie', { headers: { origin: 'https://evil.example' } }), { env: ENV, store: memoryStore(), fetchImpl: fakeFetch() });
  assert.equal(res.status, 401);
});

test('config response contains no secrets', async () => {
  const res = await handle(req('/api/config?org=samircaus&site=da-elsie'), { env: ENV, store: memoryStore(), fetchImpl: fakeFetch() });
  assert.equal(res.status, 200);
  const text = await res.text();
  for (const s of ['gsecret', 'bingkey', KEY]) assert.ok(!text.includes(s));
});

test('successful Adobe verification is cached under a token hash', async () => {
  const store = memoryStore();
  const f = fakeFetch();
  await handle(req('/api/config?org=samircaus&site=da-elsie'), { env: ENV, store, fetchImpl: f });
  await handle(req('/api/config?org=samircaus&site=da-elsie'), { env: ENV, store, fetchImpl: f });
  assert.equal(f.calls.filter((c) => c.url.includes('validate_token')).length, 1);
  assert.ok([...store._map.keys()].every((k) => !k.includes(IMS_TOKEN)));
});

test('report: URLs outside the production origin are refused before any provider call', async () => {
  const f = fakeFetch();
  const res = await handle(req(`/api/report?org=samircaus&site=da-elsie&provider=bing&url=${encodeURIComponent('https://evil.example/x')}`), { env: ENV, store: memoryStore(), fetchImpl: f });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'URL_NOT_ALLOWED');
  assert.ok(!f.calls.some((c) => c.url.includes('bing.com')));
});

test('report: Google property must be in the configured list', async () => {
  const res = await handle(req(`/api/report?org=samircaus&site=da-elsie&provider=google&property=${encodeURIComponent('sc-domain:other.dev')}&url=${encodeURIComponent('https://edgepatterns.dev/x')}`), { env: ENV, store: memoryStore(), fetchImpl: fakeFetch() });
  assert.equal(res.status, 400);
});

test('report: Google without a connection returns NOT_CONNECTED', async () => {
  const res = await handle(req(`/api/report?org=samircaus&site=da-elsie&provider=google&url=${encodeURIComponent('https://edgepatterns.dev/x')}`), { env: ENV, store: memoryStore(), fetchImpl: fakeFetch() });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error.code, 'NOT_CONNECTED');
});

test('report: Bing API key is only used for the configured siteUrl and never returned', async () => {
  const f = fakeFetch();
  const res = await handle(req(`/api/report?org=samircaus&site=da-elsie&provider=bing&url=${encodeURIComponent('https://edgepatterns.dev/x')}`), { env: ENV, store: memoryStore(), fetchImpl: f });
  assert.equal(res.status, 200);
  const bingCalls = f.calls.filter((c) => c.url.includes('bing.com'));
  assert.ok(bingCalls.length > 0);
  bingCalls.forEach((c) => assert.equal(new URL(c.url).searchParams.get('siteUrl'), 'https://edgepatterns.dev/'));
  assert.ok(!(await res.text()).includes('bingkey'));
});

test('report cache keys are namespaced by provider, principal, property, URL and days', async () => {
  const store = memoryStore();
  await handle(req(`/api/report?org=samircaus&site=da-elsie&provider=bing&url=${encodeURIComponent('https://edgepatterns.dev/x')}`), { env: ENV, store, fetchImpl: fakeFetch() });
  const key = [...store._map.keys()].find((k) => k.startsWith('cache:'));
  assert.match(key, /^cache:v1:bing:site:edgepatterns:https:\/\/edgepatterns\.dev\/:[A-Za-z0-9_-]+:28$/);
  // Stored values are encrypted.
  assert.match(store._map.get(key).value, /^v1\./);
});

test('OAuth start: state is random, stored, PKCE S256 for Google, redirect on this origin', async () => {
  const store = secureStore(memoryStore(), KEY);
  const { authorizeUrl } = await startAuthorization({
    provider: 'google', userId: 'U1', siteId: 'edgepatterns', env: ENV, store, requestUrl: 'https://si.example.workers.dev/api/oauth/google/start',
  });
  const u = new URL(authorizeUrl);
  assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(u.searchParams.get('code_challenge').length >= 43);
  assert.equal(u.searchParams.get('redirect_uri'), 'https://si.example.workers.dev/oauth/google/callback');
  assert.match(u.searchParams.get('scope'), /webmasters\.readonly/);
  assert.doesNotMatch(u.searchParams.get('scope'), /auth\/webmasters(\s|$)/);
  assert.equal(u.searchParams.get('access_type'), 'offline');
  const state = u.searchParams.get('state');
  const rec = await consumeState({ provider: 'google', state, store });
  assert.equal(rec.userId, 'U1');
  assert.ok(rec.verifier);
});

test('OAuth state is single-use, provider-bound and expires', async () => {
  const store = secureStore(memoryStore(), KEY);
  const { authorizeUrl } = await startAuthorization({ provider: 'google', userId: 'U1', siteId: 's', env: ENV, store, requestUrl: 'https://x.dev/' });
  const state = new URL(authorizeUrl).searchParams.get('state');
  await assert.rejects(consumeState({ provider: 'bing', state, store }), { code: 'OAUTH_STATE_INVALID' });
  // A mismatched provider consumed it as well: replay fails.
  await assert.rejects(consumeState({ provider: 'google', state, store }), { code: 'OAUTH_STATE_INVALID' });

  const r2 = await startAuthorization({ provider: 'google', userId: 'U1', siteId: 's', env: ENV, store, requestUrl: 'https://x.dev/' });
  const s2 = new URL(r2.authorizeUrl).searchParams.get('state');
  await assert.rejects(consumeState({ provider: 'google', state: s2, store, now: Date.now() + 11 * 60 * 1000 }), { code: 'OAUTH_STATE_INVALID' });
  await assert.rejects(consumeState({ provider: 'google', state: 'short', store }), { code: 'OAUTH_STATE_INVALID' });
});

test('OAuth callback with unknown state does not exchange a code', async () => {
  const f = fakeFetch();
  const res = await handle(req('/oauth/google/callback?code=abc&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', { token: null }), { env: ENV, store: memoryStore(), fetchImpl: f });
  assert.equal(res.status, 400);
  assert.ok(!f.calls.some((c) => c.url.includes('oauth2.googleapis.com')));
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('refresh with invalid_grant deletes the token and requires reauthorization', async () => {
  const secure = secureStore(memoryStore(), KEY);
  await secure.put(tokenKey('google', 'U1'), { refreshToken: '1//refresh' });
  const fetchImpl = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  await assert.rejects(getAccessToken({ provider: 'google', userId: 'U1', env: ENV, secure, fetchImpl }), { code: 'REAUTH_REQUIRED' });
  assert.equal(await secure.get(tokenKey('google', 'U1')), null);
});

test('encrypted values are bound to their key (no swapping)', async () => {
  const c = await encryptJson(KEY, { refreshToken: 'x' }, 'tok:google:A');
  assert.deepEqual(await decryptJson(KEY, c, 'tok:google:A'), { refreshToken: 'x' });
  await assert.rejects(decryptJson(KEY, c, 'tok:google:B'));
});

test('redaction removes tokens, secrets and codes from log lines', () => {
  const s = redact({
    detail: 'Authorization: Bearer ya29.abcdefghijkl refresh_token=1//0abcdefghijklmnopqrstuvwxyz code=4/xyz apikey=SECRET123',
    body: '{"access_token":"ya29.zzz","client_secret":"GOCSPX-123"}',
    jwt: IMS_TOKEN,
  });
  for (const secret of ['ya29.abcdefghijkl', '1//0abcdefghijklmnopqrstuvwxyz', '4/xyz', 'SECRET123', 'ya29.zzz', 'GOCSPX-123', IMS_TOKEN]) {
    assert.ok(!s.includes(secret), `leaked ${secret}`);
  }
});

test('canonical extraction handles attribute order and quoting', () => {
  assert.equal(extractCanonical('<link href="https://a.dev/x" rel="canonical">'), 'https://a.dev/x');
  assert.equal(extractCanonical("<link rel='canonical' href='/y'>"), '/y');
  assert.equal(extractCanonical('<link rel="stylesheet" href="/s.css">'), null);
});

test('page check never follows redirects off the production origin', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
  };
  const r = await checkPublishedPage('https://edgepatterns.dev/about', SITE, { fetchImpl });
  assert.equal(r.status, 'redirects-off-site');
  assert.deepEqual(calls, ['https://edgepatterns.dev/about']);
  await assert.rejects(checkPublishedPage('https://169.254.169.254/latest', SITE, { fetchImpl }), { code: 'URL_NOT_ALLOWED' });
});

test('page check reads canonical from the published page', async () => {
  const fetchImpl = async () => new Response('<html><head><link rel="canonical" href="https://edgepatterns.dev/about-us"></head></html>', { headers: { 'content-type': 'text/html' } });
  const r = await checkPublishedPage('/about', SITE, { fetchImpl });
  assert.equal(r.canonical.status, 'differs');
});

test('site config validation', () => {
  assert.deepEqual(validateSite(SITE), []);
  assert.ok(validateSite({ ...SITE, productionOrigin: 'http://x.dev' }).length);
  assert.ok(validateSite({ ...SITE, google: { properties: ['edgepatterns.dev'] } }).length);
  assert.ok(validateSite({ ...SITE, bing: { siteUrl: 'https://x.dev/', auth: 'magic' } }).length);
});

test('google consent without the Search Console checkbox reports a scope error', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'openid email',
  }), { status: 200 });
  await assert.rejects(exchangeCode({
    provider: 'google', code: 'c', record: { verifier: 'v' },
    env: { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' },
    requestUrl: 'https://search.edgepatterns.dev/oauth/google/callback', fetchImpl,
  }), { code: 'SCOPE_NOT_GRANTED' });
});
