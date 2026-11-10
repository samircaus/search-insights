# Verification status

Last updated 2026-11-09. Each line is either **live-tested**, **fixture-tested** or **unverified**.

## Live-tested

| Item | Evidence |
| --- | --- |
| Worker deployed at `https://search-insights.samircaus.workers.dev` | `/api/health` → `{"ok":true,"encryptionKey":true}` |
| API refuses unauthenticated calls | `/api/config` without a token → 401 |
| Plugin CSP restricts framing to `*.da.live` | Response header `frame-ancestors https://da.live https://*.da.live` |
| Adobe IMS `validate_token` behaviour for invalid tokens | `{"valid":false,"reason":"bad_signature"}` |
| DA admin `list` requires auth | 401 without a token and with a bogus token |
| edgepatterns.dev URL conventions | `/about` 200, `/about/` 404, `/de/` 200, `/de` 404, `.html` 404; canonical tags match the URL |
| Google Cloud project `search-insights-ew` with the Search Console API enabled | `gcloud services list` |
| Plugin outside Workspace | Shows the "runs inside Adobe Experience Workspace" message with a demo link |
| Demo mode in a browser (420 px wide) | All four scenarios render, including index status (indexed, not indexed, different Google canonical with “Use this URL”); provider switching works; brief preview and Markdown/plain text generated |

## Fixture-tested (unit tests, `npm test`)

These cover the backend with mocked IMS, DA, Google and Bing responses shaped from the official documentation:
- URL mapping
- windows and boundaries
- CTR and percentage points
- zero baselines and missing rows
- Google and Bing normalization
- low-volume suppression
- site and property authorization
- cross-origin rejection
- OAuth state, PKCE and replay
- refresh-token invalidation
- encryption binding
- redaction
- page-check redirect safety

## Unverified: needs credentials or a signed-in session

| Item | Blocked on |
| --- | --- |
| Handshake inside Workspace: actual `context.path` for edgepatterns.dev documents (with or without extension), token refresh messages, inline panel width | Library row added to `samircaus/da-elsie` config; signed-in da.live session |
| IMS `validate_token` response shape for a **valid** DA token (`token.user_id` is expected; a JWT-claims fallback is implemented) | Signed-in session |
| DA `admin.da.live/list/samircaus/da-elsie` returning 200 for an authorized user | Signed-in session |
| Live Google URL Inspection response for edgepatterns.dev pages (fields verified against the API reference only) | Same as below |
| Live Google OAuth and Search Analytics requests for edgepatterns.dev | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets; consent screen with a test user; a Search Console property for edgepatterns.dev |
| Which Google property exists (`sc-domain:edgepatterns.dev` and/or `https://edgepatterns.dev/`) | Google connection; `/api/google/properties` reports it |
| Live Bing OAuth and `GetPageQueryStats` / `GetPageStats` row-date granularity | `BING_CLIENT_ID` / `BING_CLIENT_SECRET`; Bing OAuth client registration |
| Whether Bing's JSON GET expects `page` JSON-quoted (the reference samples show `page=%22http...%22`) | Live Bing response. The adapter currently sends the plain URL. If live calls return no rows for pages that have data, try quoting. |
| Insert into document (`sendHTML`) and clipboard copy inside the Workspace iframe | Signed-in session with the plugin registered |
| `experience: fullsize-dialog` | Same |

## Next live test run (checklist)

1. Run `npx wrangler secret put GOOGLE_CLIENT_ID --name search-insights`, then the same for `GOOGLE_CLIENT_SECRET`, `BING_CLIENT_ID` and `BING_CLIENT_SECRET`.
2. Add the library row at `https://da.live/config#/samircaus/da-elsie/`.
3. Open an edgepatterns.dev page in Canvas (`https://da.live/canvas#/samircaus/da-elsie/<path>`), then choose **Search Insights** in the side-panel switcher:
   - [ ] Diagnostics lists context keys `branch, hash, org, path, ref, repo, site, view`
   - [ ] Public URL matches the published page; the canonical check is ✓
4. Google tab:
   - [ ] Connect → consent → popup closes → data loads
   - [ ] Dates end at the latest finalized day
   - [ ] Index status shows indexed, last crawl and Google canonical; Open in Search Console works
5. Bing tab:
   - [ ] Connect → data loads, or a documented error
   - [ ] Switching tabs keeps each provider's state
6. Brief:
   - [ ] Select a card and queries → Preview → Copy (paste somewhere)
   - [ ] Insert into document… → confirm → text appears at the cursor (then undo)
7. Revoke Google access at <https://myaccount.google.com/permissions> → Refresh → "Reauthorization required"
8. Use a different URL → `/de/` (or a page without data) → "No search data available"
