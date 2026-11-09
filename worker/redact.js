/**
 * Redact secrets from strings before they are logged. Applied to every log line.
 */
const PATTERNS = [
  [/(authorization\s*[:=]\s*)(bearer\s+)?[^\s,"']+/gi, '$1$2[REDACTED]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'],
  [/((?:access|refresh|id)_token["']?\s*[:=]\s*["']?)[^"'&\s,}]+/gi, '$1[REDACTED]'],
  [/((?:client_secret|code_verifier|apikey|api_key|code|state|token)=)[^&\s"']+/gi, '$1[REDACTED]'],
  [/(\\?"(?:client_secret|code|apikey|token|refresh_token|access_token|id_token)\\?"\s*:\s*\\?")[^"\\]+/gi, '$1[REDACTED]'],
  // JWT-shaped strings
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
  // Google OAuth tokens
  [/\bya29\.[A-Za-z0-9._-]+/g, '[REDACTED]'],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[REDACTED]'],
];

export function redact(input) {
  let s = typeof input === 'string' ? input : (() => {
    try { return JSON.stringify(input); } catch { return String(input); }
  })();
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

export function log(level, message, fields = {}) {
  const line = redact({ level, message, ...fields });
  // eslint-disable-next-line no-console
  (level === 'error' ? console.error : console.log)(line);
}
