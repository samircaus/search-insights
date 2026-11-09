# Authentication, access control and troubleshooting

## Who is calling the backend?

Every `/api/*` request carries `Authorization: Bearer <IMS token>`. Experience Workspace passes this token to the plugin in the SDK handshake. The backend does **not** decode-and-trust it. It requires both checks below.

1. **Adobe IMS validation:** `GET https://ims-na1.adobelogin.com/ims/validate_token/v1?client_id=darkalley&type=access_token`, with the token as bearer. It must return `{"valid": true}`. The user id is taken from the validated response (`token.user_id`).
   - The client id is configurable as `IMS_CLIENT_IDS` (comma-separated).
   - Probed live: an invalid token returns `{"valid":false,"reason":"bad_signature"}`.
2. **Site authorization by Document Authoring:** `GET https://admin.da.live/list/{org}/{site}` with the same token must return 200.
   - This uses the site's own DA permissions.
   - Probed live: unauthenticated and bogus tokens get 401.
3. **Optional allowlist:** `access.allowedUserIds` in the site config.

Successful checks are cached for 5 minutes under a SHA-256 hash of the token. The token itself is never stored or logged.

**Why not cookies?** The plugin runs in a third-party iframe inside `da.live`. Safari and Firefox block third-party cookies, and Chrome partitions iframe storage. A bearer token from the SDK avoids all of that.

**Same-origin only:** the plugin and API share an origin. The backend sends no CORS headers and rejects requests whose `Origin` or `Sec-Fetch-Site` show a different site. CORS is **not** treated as authentication; the IMS and DA checks are.

## Provider authorization (OAuth)

```
plugin (iframe) ── click "Connect" ──▶ window.open('')            (synchronous, keeps the user gesture)
plugin ── POST /api/oauth/google/start (IMS bearer) ──▶ backend
backend: state = 256-bit random; store {userId, siteId, PKCE verifier} encrypted, 10 min TTL
plugin: popup.location = Google authorize URL (S256 code_challenge, access_type=offline)
Google ──▶ /oauth/google/callback?code&state
backend: consume state once → exchange code (+ verifier, client secret) → encrypt refresh token in KV
popup: "Connected" → closes itself
plugin: polls GET /api/status every 2 s until connected (works even when COOP severs window.opener)
```

- **Popups:** the Workspace iframe has no `sandbox` attribute, so `window.open` is allowed. If the browser blocks the popup anyway, the plugin shows a link to open the sign-in page.
- **No `postMessage` back from the popup:** Google pages can set Cross-Origin-Opener-Policy, which removes `window.opener`. Storage partitioning also separates the popup (first-party) from the iframe (third-party). Polling the backend works in all browsers.
- **What is stored:** refresh tokens and short-lived access tokens are kept per Adobe user id (`tok:{provider}:{userId}`), AES-256-GCM encrypted, and bound to their key. They never reach the browser.
- **Scopes:** Google requests `webmasters.readonly`, plus `openid email` to display which account is connected. Bing requests `webmaster.read`.
- **Disconnect:** this deletes stored tokens and revokes Google's refresh token.

## Property and site restrictions

- **Google:** the `property` parameter must be in `google.properties`, and the page URL must be inside that property (Domain or URL-prefix rules). Google itself enforces that the connected account can read the property.
- **Bing:** only `bing.siteUrl` is ever queried, and only for URLs on `productionOrigin`. This matters because a Bing API key covers every site its owner verified.
- **Page check:** the backend fetches only URLs on `productionOrigin`. It uses manual redirects (max 3, each validated same-origin), a 5 s timeout and at most 1 MB read. Arbitrary outbound fetching is not possible.
- **Cache keys:** `cache:v1:{provider}:{userId | site:<id> for shared Bing key}:{property}:{sha256(url)}:{days}`, with values encrypted and a 15-minute TTL.

## Error states shown to authors

| Code | Meaning | Author action |
| --- | --- | --- |
| `NOT_CONNECTED` | No stored authorization for this provider | Connect |
| `REAUTH_REQUIRED` | Refresh token revoked or expired (Google Testing apps: 7 days) | Reconnect |
| `PROPERTY_ACCESS_DENIED` | Connected account is not a user of the property | Ask the property owner to add the account |
| `RATE_LIMITED` | Provider quota exceeded | Try again later |
| `PROVIDER_UNAVAILABLE` | Network or 5xx from the provider | Try again |
| `NOT_CONFIGURED` | Provider secrets missing on the backend | Deployer completes setup |
| `FORBIDDEN_SITE` | User cannot read the site in DA, the site is not configured, or the user is not on the allowlist | Check DA permissions or config |
| `UNAUTHENTICATED` | IMS token missing, invalid or expired | Reload Workspace |
| No data (not an error) | Provider returned no impressions | Shown as "No search data available" |

A failure in one provider never disables the other tab. Failed live requests **never** fall back to fixtures.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "Search Insights runs inside Adobe Experience Workspace" | The plugin URL was opened directly. Use `?demo`, or open it from the Workspace library. |
| "Experience Workspace did not respond" | The handshake timed out. Reload the document. Make sure the library `experience` is not `window`. |
| Plugin frame is blank, with a console error about `frame-ancestors` | You embed it somewhere other than `*.da.live`. Edit `web/_headers`. |
| `redirect_uri_mismatch` from Google | The registered redirect URI must exactly equal `{PUBLIC_BASE_URL or worker origin}/oauth/google/callback`. |
| "Access blocked: app has not completed verification" | Add the author as a test user, or publish and verify the consent screen. |
| Reconnect needed every week | The Google consent screen is in Testing (7-day refresh tokens). |
| `PROPERTY_ACCESS_DENIED` | `google.properties` must match Search Console exactly (`sc-domain:` prefix, or a trailing `/` for URL-prefix). |
| Bing `REAUTH_REQUIRED` with an API key | The key was regenerated or deleted in Bing Webmaster Tools. Run `wrangler secret put BING_API_KEY` again. |
| Logs | `npx wrangler tail`. Lines are redacted: bearer tokens, OAuth codes and tokens, API keys and JWTs are replaced with `[REDACTED]`. |
