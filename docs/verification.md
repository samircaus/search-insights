# Verification status

Last updated 2026-11-13. Each line is either **live-tested**, **fixture-tested** or **unverified**.

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
| Demo mode in a browser (420 px wide) | All four scenarios rendered, including index status (indexed, not indexed, different Google canonical with “Use this URL”), and provider switching worked. The earlier brief preview has since been replaced locally by **Ask in Chat**. |
| Workspace library registration and SDK handshake | On 2026-11-10, the `samircaus/da-elsie` library row opened Search Insights in the Canvas side panel. Diagnostics listed `branch, hash, org, path, ref, repo, site, view` and reported `sendHTML` available. |
| Workspace page resolution and backend access | The `/martech/fpid` document resolved to `https://edgepatterns.dev/martech/fpid` with a matching canonical. Authenticated `/api/config`, `/api/status` and `/api/page-check` requests returned 200. |
| Provider configuration | On 2026-11-10, both Google and Bing appeared as not configured in the live Workspace panel. |
| Google connection, Search Analytics and URL Inspection | On 2026-11-13 the user connected `sc-domain:edgepatterns.dev`. The Workspace panel showed live metrics, four query rows, and an indexed URL Inspection result for `/martech/fpid`: [overview](screenshots/live-google-overview.png), [queries](screenshots/live-google-queries.png). |
| Live headless page | A user-supplied Workspace capture shows 1,469 impressions, 58 returned queries and a selected suggestion for `/architecture/headless`: [Workspace](screenshots/search-insights-workspace-live.png), [overview](screenshots/search-insights-overview-live.png), [queries](screenshots/search-insights-queries-live.png). A Chat response is visible, but the handoff itself is not shown. |

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
- Local Spectrum 2 preview with demo fixtures at 300 px and 420 px in light and dark modes. Workspace styles and Adobe Clean fonts loaded under the plugin CSP; URL override, query filtering, brief preview and keyboard tab switching were exercised. The deployed revision has not been independently identified.
- Local demo: account details are hidden until requested; the query table shows 10 rows initially, preserves selections when expanded, and filters across all returned rows. The live Workspace capture shows the Account control and a selected suggestion, but does not show pagination being exercised.

## Unverified or needs further testing

| Item | Blocked on |
| --- | --- |
| Other Workspace document path formats, token refresh messages and inline panel width | Further signed-in testing across documents |
| IMS `validate_token` response shape for a **valid** DA token (`token.user_id` is expected; a JWT-claims fallback is implemented) | Signed-in session |
| Whether the URL-prefix property `https://edgepatterns.dev/` is available to the Google account | The 13 November panel showed it as inaccessible; it may be missing, unverified or lack permission. The domain property is accessible. |
| Live Bing OAuth and `GetPageQueryStats` / `GetPageStats` row-date granularity | `BING_CLIENT_ID` / `BING_CLIENT_SECRET`; Bing OAuth client registration |
| Whether Bing's JSON GET expects `page` JSON-quoted (the reference samples show `page=%22http...%22`) | Live Bing response. The adapter currently sends the plain URL. If live calls return no rows for pages that have data, try quoting. |
| **Ask in Chat** handoff in the live Workspace host | Verify that selected evidence appears in an unsent prompt; the capture shows a Chat response but not the handoff itself. The SDK call has no host acknowledgement. |
| `experience: fullsize-dialog` | Same |

## Bing for edgepatterns.dev

The selected live-demo scope is Google only. Bing remains in the site configuration without credentials and has not been tested live. The Workspace capture shows no Bing tab. The adapter, tests and demo fixtures remain in place.

## Next live test run (checklist)

1. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as Worker secrets in the Cloudflare dashboard, or use `npx wrangler secret put` for each. Bing credentials are not needed for the Google-only run.
2. [x] Add the library row at `https://da.live/config#/samircaus/da-elsie/`.
3. Open an edgepatterns.dev page in Canvas (`https://da.live/canvas#/samircaus/da-elsie/<path>`), then choose **Search Insights** in the side-panel switcher:
   - [x] Diagnostics (`?debug`) lists context keys `branch, hash, org, path, ref, repo, site, view`
   - [x] Public URL matches the published page; the canonical check is ✓
4. Google tab:
   - [x] Connect and load live data, as reported by the user and shown in the 13 November capture
   - [ ] Dates end at the latest finalized day
   - [x] Index status shows indexed, last crawl and Google canonical
   - [ ] Open **Index details** and confirm the Search Console link works
5. Bing tab, if enabled for a later run:
   - [ ] Connect → data loads, or a documented error
   - [ ] Switching tabs keeps each provider's state
6. Chat handoff:
   - [ ] Select a suggestion and a query → **Ask in Chat** → selected evidence appears in an unsent prompt
7. Revoke Google access at <https://myaccount.google.com/permissions> → Refresh → "Reauthorization required"
8. Change URL → `/de/` (or a page without data) → "No search data available"
