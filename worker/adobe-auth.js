/**
 * Authenticate requests from the Workspace extension.
 *
 * The extension forwards the Adobe IMS access token that Experience Workspace
 * hands to plugins (`token` in the SDK handshake). We do NOT decode-and-trust
 * it. Two server-side checks are required:
 *
 *  1. Adobe IMS validates the token:
 *     GET https://ims-na1.adobelogin.com/ims/validate_token/v1?client_id=<id>&type=access_token
 *     -> { valid: true, token: { user_id, client_id, ... } }
 *  2. Document Authoring confirms that this user can read the configured site:
 *     GET https://admin.da.live/list/{org}/{site}  -> 200
 *
 * Optionally the site config restricts access to specific IMS user ids.
 * Successful checks are cached for a few minutes under a hash of the token.
 */
import { AppError } from './errors.js';
import { sha256 } from './crypto.js';
import { log } from './redact.js';

const IMS_VALIDATE = 'https://ims-na1.adobelogin.com/ims/validate_token/v1';
const DA_ADMIN = 'https://admin.da.live';
const CACHE_TTL = 300;

export function bearer(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,8192})$/.exec(h.trim());
  return m ? m[1] : null;
}

function decodeClaims(token) {
  // Used ONLY after IMS reported the token valid, to read the user id when the
  // validation response does not include claims.
  try {
    const [, payload] = token.split('.');
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return {};
  }
}

async function validateWithIms(token, { fetchImpl, clientIds }) {
  for (const clientId of clientIds) {
    const url = `${IMS_VALIDATE}?client_id=${encodeURIComponent(clientId)}&type=access_token`;
    let resp;
    try {
      resp = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
    } catch (e) {
      throw new AppError('PROVIDER_UNAVAILABLE', `ims unreachable: ${e.message}`);
    }
    if (resp.status >= 500) throw new AppError('PROVIDER_UNAVAILABLE', `ims ${resp.status}`);
    const body = await resp.json().catch(() => ({}));
    if (body?.valid === true) {
      const claims = body.token && typeof body.token === 'object' ? body.token : decodeClaims(token);
      return { clientId, claims };
    }
  }
  return null;
}

async function canReadDaSite(token, org, site, fetchImpl) {
  const url = `${DA_ADMIN}/list/${encodeURIComponent(org)}/${encodeURIComponent(site)}`;
  let resp;
  try {
    resp = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  } catch (e) {
    throw new AppError('PROVIDER_UNAVAILABLE', `da unreachable: ${e.message}`);
  }
  if (resp.status >= 500) throw new AppError('PROVIDER_UNAVAILABLE', `da ${resp.status}`);
  return resp.ok;
}

/**
 * @returns {Promise<{userId:string, tokenHash:string}>}
 */
export async function authenticate(request, site, { env, store, fetchImpl = fetch }) {
  const token = bearer(request);
  if (!token) throw new AppError('UNAUTHENTICATED', 'missing bearer');
  const tokenHash = await sha256(token);
  const cacheKey = `adobe:${tokenHash}:${site.id}`;
  const cached = await store.get(cacheKey);
  let userId = cached?.userId;

  if (!userId) {
    const clientIds = String(env.IMS_CLIENT_IDS || 'darkalley').split(',').map((s) => s.trim()).filter(Boolean);
    const ims = await validateWithIms(token, { fetchImpl, clientIds });
    if (!ims) throw new AppError('UNAUTHENTICATED', 'ims rejected token');
    userId = ims.claims.user_id || ims.claims.sub;
    if (!userId) throw new AppError('UNAUTHENTICATED', 'no user id in validated token');
    const expiresAt = Number(ims.claims.created_at) + Number(ims.claims.expires_in);
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) {
      throw new AppError('UNAUTHENTICATED', 'token expired');
    }
    const allowed = await canReadDaSite(token, site.da.org, site.da.site, fetchImpl);
    if (!allowed) throw new AppError('FORBIDDEN_SITE', 'da list denied');
    await store.put(cacheKey, { userId }, { ttl: CACHE_TTL });
    log('info', 'adobe user verified', { site: site.id });
  }

  const allow = site.access?.allowedUserIds;
  if (Array.isArray(allow) && allow.length && !allow.includes(userId)) {
    throw new AppError('FORBIDDEN_SITE', 'user not in allowlist');
  }
  return { userId, tokenHash };
}
