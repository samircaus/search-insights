/**
 * Experience Workspace adapter. The only module that touches the DA App SDK.
 *
 * Verified integration (adobe/da-nx nx/utils/sdk.js, adobe/da-live
 * blocks/canvas/ew-panel-extensions/iframe-protocol.js):
 *  - The host posts { ready: true, context, token, capabilities } plus a
 *    MessagePort ~750 ms after the plugin iframe loads.
 *  - context: { org, repo, site, ref, path, view, hash, branch }
 *  - actions.sendText / sendHTML insert at the cursor (fire-and-forget);
 *    actions.closeLibrary closes the panel.
 *  - Outside Workspace the SDK promise never resolves, so we time out.
 *
 * Tokens are never logged or rendered.
 */

const SDK_URL = 'https://da.live/nx/utils/sdk.js';
const TRUSTED_PARENT = /^https:\/\/([a-z0-9-]+\.)*da\.live$/;
const CONTEXT_KEYS = ['org', 'repo', 'site', 'ref', 'path', 'view', 'hash', 'branch'];

let latestToken = null;

function watchTokenRefresh() {
  // The SDK keeps refreshed IMS tokens internally without exposing them, so we
  // track the same parent messages ourselves (trusted parent origin only).
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !TRUSTED_PARENT.test(e.origin)) return;
    if (typeof e.data?.token === 'string' && e.data.token) latestToken = e.data.token;
  });
}

function pickContext(ctx) {
  const out = {};
  if (!ctx || typeof ctx !== 'object') return out;
  for (const k of CONTEXT_KEYS) {
    if (typeof ctx[k] === 'string') out[k] = ctx[k];
  }
  return out;
}

function timeout(ms) {
  return new Promise((resolve) => { setTimeout(() => resolve({ timedOut: true }), ms); });
}

/**
 * @returns {Promise<{status:'outside'}|{status:'no-handshake'}|{status:'sdk-unavailable'}|
 *   {status:'ready', context, contextKeys, capabilities, getToken, actions}>}
 */
export async function connectWorkspace({ timeoutMs = 6000 } = {}) {
  if (window.parent === window) return { status: 'outside' };
  watchTokenRefresh();
  let sdk;
  try {
    sdk = await import(SDK_URL);
  } catch {
    return { status: 'sdk-unavailable' };
  }
  const res = await Promise.race([sdk.default.then((v) => ({ v })), timeout(timeoutMs)]);
  if (res.timedOut) return { status: 'no-handshake' };
  const {
    context, token, actions = {}, capabilities = {},
  } = res.v;
  if (typeof token === 'string' && !latestToken) latestToken = token;
  const safeContext = pickContext(context);
  return {
    status: 'ready',
    context: safeContext,
    // Keys only, for diagnostics. Values of context are non-secret but token is never included.
    contextKeys: Object.keys(context || {}).sort(),
    capabilities: { ...capabilities },
    getToken: () => latestToken,
    actions: {
      canInsertHtml: typeof actions.sendHTML === 'function',
      canInsertText: typeof actions.sendText === 'function',
      canClose: typeof actions.closeLibrary === 'function',
      insertHtml: (html) => actions.sendHTML(html),
      insertText: (text) => actions.sendText(text),
      close: () => actions.closeLibrary(),
    },
  };
}
