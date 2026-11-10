/**
 * Backend client. Every call carries the Workspace IMS token as a bearer token;
 * the backend validates it with Adobe IMS and Document Authoring.
 */

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createApi({ getToken, org, site, base = '' }) {
  async function call(path, { method = 'GET', params = {} } = {}) {
    const url = new URL(base + path, window.location.origin);
    url.searchParams.set('org', org);
    url.searchParams.set('site', site);
    Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, v); });
    const token = getToken();
    if (!token) throw new ApiError('UNAUTHENTICATED', 'No Experience Workspace session token is available. Reload Workspace and try again.', 401);
    let resp;
    try {
      resp = await fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
    } catch {
      throw new ApiError('NETWORK', 'Could not reach the Search Insights service.', 0);
    }
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new ApiError(body?.error?.code || 'INTERNAL', body?.error?.message || `Request failed (${resp.status}).`, resp.status);
    }
    return body;
  }
  return {
    mode: 'live',
    config: () => call('/api/config'),
    status: () => call('/api/status'),
    properties: () => call('/api/google/properties'),
    report: (provider, pageUrl, { property, days, refresh } = {}) => call('/api/report', {
      params: {
        provider, url: pageUrl, property, days, refresh: refresh ? '1' : undefined,
      },
    }),
    inspect: (pageUrl, { property, refresh } = {}) => call('/api/google/inspect', {
      params: { url: pageUrl, property, refresh: refresh ? '1' : undefined },
    }),
    pageCheck: (pageUrl) => call('/api/page-check', { params: { url: pageUrl } }),
    startOAuth: (provider) => call(`/api/oauth/${provider}/start`, { method: 'POST' }),
    disconnect: (provider) => call(`/api/oauth/${provider}/disconnect`, { method: 'POST' }),
  };
}
