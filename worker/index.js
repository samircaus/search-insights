/**
 * Cloudflare Workers entry point. Static plugin files are served from ./web by
 * Workers Static Assets; /api/* and /oauth/* run through the shared handler.
 */
import { handle } from './app.js';
import { kvStore } from './store.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth/')) {
      const res = await handle(request, { env, store: kvStore(env.SI_KV), fetchImpl: fetch });
      if (res) return res;
    }
    return env.ASSETS.fetch(request);
  },
};
