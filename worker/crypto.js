/** WebCrypto helpers (available in Workers and Node >= 20). */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 1) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return b64url(new Uint8Array(digest));
}

/** PKCE (RFC 7636) S256 challenge. */
export async function pkceChallenge(verifier) {
  return sha256(verifier);
}

const keyCache = new Map();
async function importKey(secret) {
  if (keyCache.has(secret)) return keyCache.get(secret);
  if (!secret) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const raw = fromB64url(secret.trim());
  if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64url encoded');
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  keyCache.set(secret, key);
  return key;
}

/** AES-256-GCM. `aad` binds the ciphertext to its storage key so values cannot be swapped. */
export async function encryptJson(secret, value, aad = '') {
  const key = await importKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function decryptJson(secret, payload, aad = '') {
  const [v, iv, ct] = String(payload).split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('bad ciphertext');
  const key = await importKey(secret);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64url(iv), additionalData: enc.encode(aad) },
    key,
    fromB64url(ct),
  );
  return JSON.parse(dec.decode(pt));
}

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
