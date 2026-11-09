/** Error codes returned to the extension. Messages are author-facing and never contain secrets. */
export const ERRORS = {
  UNAUTHENTICATED: { status: 401, message: 'Your Experience Workspace session could not be verified. Reload the page and try again.' },
  FORBIDDEN_SITE: { status: 403, message: 'You do not have access to this site in Experience Workspace, or it is not configured for Search Insights.' },
  NOT_CONFIGURED: { status: 404, message: 'This provider is not configured for this site.' },
  URL_NOT_ALLOWED: { status: 400, message: 'That URL is not part of the configured site or property.' },
  BAD_REQUEST: { status: 400, message: 'The request was not valid.' },
  NOT_CONNECTED: { status: 409, message: 'Not connected. Connect your account to load data.' },
  REAUTH_REQUIRED: { status: 409, message: 'Authorization expired or was revoked. Reconnect your account.' },
  PROPERTY_ACCESS_DENIED: { status: 403, message: 'The connected account cannot access this property.' },
  RATE_LIMITED: { status: 429, message: 'The provider rate limit was reached. Try again in a few minutes.' },
  PROVIDER_UNAVAILABLE: { status: 502, message: 'The provider is unavailable right now. Try again later.' },
  OAUTH_STATE_INVALID: { status: 400, message: 'The sign-in request expired or was already used. Start the connection again.' },
  INTERNAL: { status: 500, message: 'Something went wrong.' },
};

export class AppError extends Error {
  constructor(code, detail) {
    const def = ERRORS[code] || ERRORS.INTERNAL;
    super(def.message);
    this.code = ERRORS[code] ? code : 'INTERNAL';
    this.status = def.status;
    this.detail = detail; // internal only, redacted before logging
  }
}

export function errorBody(err) {
  if (err instanceof AppError) return { error: { code: err.code, message: err.message } };
  return { error: { code: 'INTERNAL', message: ERRORS.INTERNAL.message } };
}
