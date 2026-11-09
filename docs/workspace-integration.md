# Experience Workspace integration

Everything below was verified against current documentation and source on 2026-11-09. Each section notes which parts were also confirmed in the running host.

## Sources

| Source | What it establishes |
| --- | --- |
| <https://www.aem.live/docs/ew/developing/apps-plugins> | Library plugins are iframes using the DA App SDK. Documented SDK usage is `const { context, token, actions } = await DA_SDK;` with `actions.sendText`, `actions.sendHTML` and `actions.closeLibrary`. `ref=local` loads from `http://localhost:3000`. |
| <https://www.aem.live/docs/ew/developing/micro-frontends> | Micro-frontend approach: low dependencies and no framework requirement. |
| <https://www.aem.live/docs/ew/administering/set-up-library> | The `library` tab of the site config, with columns `title`, `path`, `format`, `ref`, `icon`, `experience`. |
| <https://www.aem.live/docs/ew/administering/prepare-menu> | Prepare-menu plugins use the same SDK. `experience: fullsize-dialog` opens a large dialog. |
| <https://da.live/nx/utils/sdk.js> | SDK source (see below). |
| `adobe/da-nx` `docs/sdk-messaging.md` | Capability negotiation: "An action's presence does not prove EW support." |
| `adobe/da-live` `blocks/canvas/ew-panel-extensions/iframe-protocol.js` | The host side of the handshake and the actions it handles. |
| `adobe/da-live` `blocks/canvas/ew-panel-extensions/helpers.js` | How `library` rows become Workspace panels, `ref` filtering, source URL rules and the preview proxy. |

## Handshake

`sdk.js` resolves `DA_SDK` on the first `window` message that carries both `ready` and a transferred `MessagePort`. It resolves to `{ ...e.data, actions }`.

The Experience Workspace host (`iframe-protocol.js`) posts the following about **750 ms after the iframe `load` event**:

```js
{
  ready: true,
  project: context,
  context: { org, repo: site, site, ref, path: '/' + path, view, hash, branch },
  token,          // Adobe IMS access token (DA client "darkalley")
  capabilities: { liveDocument: 1, sendHTMLReplace: 1, chatTurnCompleted: 1, dragDrop: 1 },
}
```

- **Never resolves outside Workspace:** if no handshake arrives, the promise stays pending. `web/workspace.js` therefore times out after 6 s and shows "Open from Experience Workspace" plus a demo link. It also detects top-level loading immediately (`window.parent === window`).
- **Token refresh:** later messages that carry a `token` refresh IMS details inside the SDK, which does not expose them. The adapter tracks the same messages, but only from `window.parent` with a `https://*.da.live` origin. That way API calls use the latest token.
- **What the adapter keeps:** only the documented context keys (`org`, `repo`, `site`, `ref`, `path`, `view`, `hash`, `branch`). The Diagnostics disclosure lists the context *keys* and capability names. The token is never logged or rendered.

## Actions used

| Action | Status | Use |
| --- | --- | --- |
| `sendHTML(html)` | Documented, and handled by the host as an insertion at the cursor (fire-and-forget) | Optional **Insert into document…** after an explicit confirmation. All brief text is HTML-escaped. |
| `sendText`, `closeLibrary` | Documented | Feature-detected; not required. |
| `sendHTML(html, { replace: true })`, `saveDocument`, `subscribeLiveDocument`, `setPrompt`, … | In SDK source; capability-gated | **Not used.** The plugin never replaces content, saves or publishes. |

## Library registration

The host reads `library` rows from the org and site configs (`fetchExtensions`):
- **Name:** derived from `title`.
- **`ref`:** a row is shown when `ref` is empty or `main`, when it equals the `?ref=` query parameter, or when `?ref=local` is set.
- **`path`:** a relative path becomes `https://{ref}--{site}--{org}.aem.live{path}`, or `http://localhost:3000{path}` with `ref=local`. Absolute URLs are kept.
- **Preview proxy:** `toPreviewProxyUrl` rewrites only `*.aem.page|live`, `content.da.live` and `admin.da.live` URLs. A `*.workers.dev` URL is therefore loaded directly.
- **`experience`:** `inline` (default) or `fullsize-dialog` (a large modal with its own iframe and handshake). `window` opens a tab, has no handshake and is unsupported here.
- **iframe attributes:** `allow="clipboard-write *"` with no `sandbox`. Clipboard writes and `window.open` popups therefore work from the plugin.

## App Builder / UI Extensibility discrepancy

- **What the challenge says:** the announcement (as described in the brief) mentions Adobe App Builder and UI Extensibility. The page linked as the challenge source (<https://adobelabs.dev/events/dev-live26/experience-workspace/>) is a hands-on lab workbook. It mentions neither App Builder nor UI Extensibility, and gives no submission rules. A web search on 2026-11-09 did not find the announcement.
- **What Workspace documents:** the Experience Workspace documentation describes the DA App SDK (`postMessage` + `MessagePort`) and separately hosted micro-frontends registered in the site's `library` / `prepare` / `apps` sheets.
- **Why they differ:** App Builder UI Extensibility uses `@adobe/uix-sdk` extension points registered through Adobe Developer Console. That is a different framework, and no Workspace extension point for it is documented.
- **What this project does:**
  - The frontend uses the documented Workspace SDK.
  - The backend is portable: `worker/app.js` `handle(request, { env, store, fetchImpl })` depends only on standard `fetch`, `Request`/`Response`, WebCrypto and a three-method store.
  - Moving it to App Builder Runtime would mean wrapping `handle()` in an action and implementing `store` with `aio-lib-state`. That would let an App Builder-hosted backend satisfy an App Builder hosting requirement, if one exists. **This port has not been built or tested.**
- **Open question:** whether the competition requires App Builder hosting must be confirmed with the organisers.
