/**
 * Server-side OAuth 2.0 authorization-code flow for Google (with PKCE) and
 * Bing Webmaster (state only; Bing does not document PKCE support).
 *
 * - `state` is a 256-bit random value stored server-side for 10 minutes and
 *   consumed exactly once. It binds the callback to the Adobe user and site
 *   that started the flow.
 * - Refresh tokens are encrypted (AES-GCM) before storage and never sent to
 *   the browser.
 */
import { AppError } from './errors.js';
import { randomToken, pkceChallenge, safeEqual } from './crypto.js';

export const PROVIDERS = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    scope: 'openid email https://www.googleapis.com/auth/webmasters.readonly',
    pkce: true,
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    extraParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  bing: {
    authorizeUrl: 'https://www.bing.com/webmasters/oauth/authorize',
    tokenUrl: 'https://www.bing.com/webmasters/oauth/token',
    scope: 'webmaster.read',
    pkce: false,
    clientId: (env) => env.BING_CLIENT_ID,
    clientSecret: (env) => env.BING_CLIENT_SECRET,
    extraParams: {},
  },
};

const STATE_TTL = 600;

export function redirectUri(env, provider, requestUrl) {
  const base = env.PUBLIC_BASE_URL || new URL(requestUrl).origin;
  return `${base.replace(/\/$/, '')}/oauth/${provider}/callback`;
}

export function tokenKey(provider, userId) {
  return `tok:${provider}:${userId}`;
}

export async function startAuthorization({
  provider, userId, siteId, env, store, requestUrl,
}) {
  const def = PROVIDERS[provider];
  if (!def || !def.clientId(env) || !def.clientSecret(env)) throw new AppError('NOT_CONFIGURED', provider);
  const state = randomToken(32);
  const record = { provider, userId, siteId, createdAt: Date.now() };
  const params = new URLSearchParams({
    client_id: def.clientId(env),
    redirect_uri: redirectUri(env, provider, requestUrl),
    response_type: 'code',
    scope: def.scope,
    state,
    ...def.extraParams,
  });
  if (def.pkce) {
    record.verifier = randomToken(48);
    params.set('code_challenge', await pkceChallenge(record.verifier));
    params.set('code_challenge_method', 'S256');
  }
  await store.put(`state:${state}`, record, { ttl: STATE_TTL });
  return { authorizeUrl: `${def.authorizeUrl}?${params}`, expiresIn: STATE_TTL };
}

/** Look up and consume the state exactly once. */
export async function consumeState({ provider, state, store, now = Date.now() }) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(state)) {
    throw new AppError('OAUTH_STATE_INVALID', 'malformed state');
  }
  const key = `state:${state}`;
  const record = await store.get(key);
  await store.delete(key);
  if (!record) throw new AppError('OAUTH_STATE_INVALID', 'unknown state');
  if (!safeEqual(record.provider, provider)) throw new AppError('OAUTH_STATE_INVALID', 'provider mismatch');
  if (now - record.createdAt > STATE_TTL * 1000) throw new AppError('OAUTH_STATE_INVALID', 'expired');
  return record;
}

function decodeIdTokenEmail(idToken) {
  // The id_token comes directly from Google's token endpoint over TLS
  // (OIDC Core 3.1.3.7 allows skipping signature validation in this case).
  // It is used only to display which account is connected.
  try {
    const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.email_verified === false ? null : payload.email || null;
  } catch {
    return null;
  }
}

export async function exchangeCode({
  provider, code, record, env, requestUrl, fetchImpl = fetch,
}) {
  const def = PROVIDERS[provider];
  const body = new URLSearchParams({
    client_id: def.clientId(env),
    client_secret: def.clientSecret(env),
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(env, provider, requestUrl),
  });
  if (def.pkce) body.set('code_verifier', record.verifier);
  const resp = await fetchImpl(def.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json.access_token) {
    throw new AppError('PROVIDER_UNAVAILABLE', `token exchange failed ${resp.status} ${json.error || ''}`);
  }
  if (!json.refresh_token) {
    throw new AppError('PROVIDER_UNAVAILABLE', 'no refresh token returned');
  }
  if (provider === 'google' && !String(json.scope || '').includes('webmasters')) {
    throw new AppError('PROPERTY_ACCESS_DENIED', 'search console scope not granted');
  }
  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    expiresIn: Number(json.expires_in) || 3600,
    account: provider === 'google' && json.id_token ? decodeIdTokenEmail(json.id_token) : null,
    scope: json.scope || def.scope,
  };
}

/**
 * Get a valid access token for a user, refreshing when needed.
 * Access tokens are cached (encrypted) until shortly before expiry.
 */
export async function getAccessToken({
  provider, userId, env, secure, fetchImpl = fetch,
}) {
  const atKey = `atok:${provider}:${userId}`;
  const cached = await secure.get(atKey);
  if (cached?.accessToken && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const stored = await secure.get(tokenKey(provider, userId));
  if (!stored?.refreshToken) throw new AppError('NOT_CONNECTED', provider);
  const def = PROVIDERS[provider];
  const resp = await fetchImpl(def.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: def.clientId(env),
      client_secret: def.clientSecret(env),
      refresh_token: stored.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const json = await resp.json().catch(() => ({}));
  if (json.error === 'invalid_grant') {
    // Revoked, expired (e.g. 7-day limit for Google apps in "Testing") or password change.
    await secure.delete(tokenKey(provider, userId));
    throw new AppError('REAUTH_REQUIRED', 'refresh failed: invalid_grant');
  }
  if (json.error === 'invalid_client' || json.error === 'unauthorized_client') {
    throw new AppError('NOT_CONFIGURED', `oauth client rejected: ${json.error}`);
  }
  if (!resp.ok || !json.access_token) throw new AppError('PROVIDER_UNAVAILABLE', `refresh ${resp.status}`);
  const expiresIn = Number(json.expires_in) || 3600;
  await secure.put(atKey, { accessToken: json.access_token, expiresAt: Date.now() + expiresIn * 1000 }, { ttl: Math.max(60, expiresIn - 120) });
  if (json.refresh_token && json.refresh_token !== stored.refreshToken) {
    await secure.put(tokenKey(provider, userId), { ...stored, refreshToken: json.refresh_token });
  }
  return json.access_token;
}

export async function disconnect({
  provider, userId, secure, fetchImpl = fetch,
}) {
  const stored = await secure.get(tokenKey(provider, userId));
  await secure.delete(tokenKey(provider, userId));
  await secure.delete(`atok:${provider}:${userId}`);
  const def = PROVIDERS[provider];
  if (stored?.refreshToken && def.revokeUrl) {
    try {
      await fetchImpl(def.revokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: stored.refreshToken }),
      });
    } catch { /* best effort */ }
  }
  return { disconnected: true };
}
