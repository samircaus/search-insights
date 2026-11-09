/**
 * Minimal key-value store interface so business logic is independent of the
 * hosting platform. Implementations: Cloudflare KV, in-memory (tests/local).
 * An App Builder port would implement the same three methods on @adobe/aio-lib-state.
 */
import { encryptJson, decryptJson } from './crypto.js';

export function kvStore(kv) {
  return {
    async get(key) {
      const v = await kv.get(key);
      return v === null ? null : JSON.parse(v);
    },
    async put(key, value, { ttl } = {}) {
      // KV requires expirationTtl >= 60
      const opts = ttl ? { expirationTtl: Math.max(60, Math.floor(ttl)) } : undefined;
      await kv.put(key, JSON.stringify(value), opts);
    },
    async delete(key) {
      await kv.delete(key);
    },
  };
}

export function memoryStore(now = () => Date.now()) {
  const m = new Map();
  return {
    async get(key) {
      const e = m.get(key);
      if (!e) return null;
      if (e.exp && e.exp < now()) { m.delete(key); return null; }
      return structuredClone(e.value);
    },
    async put(key, value, { ttl } = {}) {
      m.set(key, { value: structuredClone(value), exp: ttl ? now() + ttl * 1000 : 0 });
    },
    async delete(key) { m.delete(key); },
    _map: m,
  };
}

/** Encrypted wrapper: values are AES-GCM encrypted and bound to their key. */
export function secureStore(store, secret) {
  return {
    async get(key) {
      const v = await store.get(key);
      if (v === null) return null;
      try {
        return await decryptJson(secret, v, key);
      } catch {
        return null; // wrong key / tampered -> treat as absent
      }
    },
    async put(key, value, opts) {
      await store.put(key, await encryptJson(secret, value, key), opts);
    },
    async delete(key) { await store.delete(key); },
  };
}
