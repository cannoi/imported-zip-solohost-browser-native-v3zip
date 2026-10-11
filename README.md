# SoloHost Browser V10.11.0

Version 10.11.0 improves engine-first navigation, session persistence, popup tracking, YouTube home/feed rendering, and policy-aware sign-in handoff. Bing remains the default search engine for unqualified searches.

See `docs/V10.11.0_ENGINE_FIRST_BROWSER_REPORT.md` for changes, limitations, and validation.

Lightweight private browser for **Pi Network SoloHost**.

## Engine (honest)

**Mode:** hybrid-proxy (Node UI + same-origin HTML proxy in an iframe).

Native **WebKitGTK cannot** paint into the remote SoloHost web page without a display transport. See `docs/V10_ARCHITECTURE.md`.

## Features preserved

Address bar, tabs, back/forward/home/reload, bookmarks, history, AI panel, Feedback, Settings, Logs.


## V10.11.0 — Engine-first compatibility and session stability

- Playwright storage state (cookies/local storage) persists under `/app/data/browser-state` by default; set `SOLOHOST_BROWSER_PERSIST_SESSIONS=0` to disable.
- Popup/new-page tracking and shorter SPA navigation waits improve stability on dynamic sites.
- YouTube home/feed stays a page instead of being replaced with embed cards.
- Google Account and known Facebook/TikTok sign-in flows use the system browser when required by site policy. The external browser's cookies are not shared with the embedded engine.
- This app still displays sanitized DOM snapshots, not a live pixel-perfect Chromium viewport; some canvas/iframe/DRM/media experiences require a system browser.

## V10.9.9 — Bing default and responsive results

- Bare text in the address bar searches Bing by default; entering an explicit `https://...` URL remains unchanged.
- Browser Agent and backend quick-search routing use Bing for general searches; explicit Google and YouTube searches remain supported.
- Bing result cards, snippets, header, and search box receive mobile-first Bridge layout rules.
- Google `/sorry/` fallback now extracts a query only from a real search URL/continuation, avoiding challenge tokens being sent as search terms.
- Google sign-in rejection is separately logged. Google security challenges are not bypassed; some account sign-ins may need the system browser.
- See `docs/V10.9.9_BING_DEFAULT_REPORT.md` for scope and validation notes.

## V10.9.8 — Mobile-first rendering and engine recovery

- Chromium remains the primary Playwright engine; startup falls back to Firefox/WebKit when an installed engine cannot launch. Runtime browser disconnects place the failing engine on a short cooldown before fallback retry.
- Mobile viewport and touch emulation are enabled by default (`SOLOHOST_BROWSER_MOBILE=1`); set it to `0` for desktop context.
- DOM Bridge snapshots and proxy HTML both apply responsive layout rules; `m.youtube.com` is preserved instead of forcibly redirected to `www.youtube.com`.
- Google `/sorry/`/unusual-traffic responses are recognized as upstream verification. Search queries use a clearly labeled DuckDuckGo fallback when available; Google CAPTCHA is not bypassed.
- Closed Playwright pages/contexts are recreated before navigation and bridge actions.
- See `docs/V10.9.8_MOBILE_ENGINE_RECOVERY_REPORT.md` for diagnosis, scope, and validation limits.

## V10.9.7 — Login, YouTube playback and AI Agent recovery

- Fixed a JavaScript syntax error in `lib/browser-agent.js` that caused the server to silently fall back to `agent_off` for both the planner and backend task agent.
- Google sign-in pages and sparse search forms now keep their sanitized interactive DOM controls instead of being replaced by a screenshot-only fallback.
- YouTube watch URLs are routed to the titled player handler instead of being intercepted by the generic shell.
- The DOM Bridge viewport CSP allows only official YouTube embed origins; the viewport sandbox allows nested player scripts while the bridge document itself remains `script-src 'none'`.
- The normal test command now checks every shipped JavaScript file and includes Browser Agent, backend-agent and YouTube regression tests.
- Updated stale tests that assumed all routes lived in `server.js`; current routes are mounted from `server-app.js`.

### Important limits

This remains a Docker-hosted Chromium backend with a sanitized DOM snapshot viewport, not a pixel-streamed full Chrome window. Google sign-in may still require an external browser if Google enforces CAPTCHA/device verification. YouTube playback depends on the target video, embed permissions, browser policy, network and SoloHost deployment; DRM/Widevine is not claimed. No automated test here proves live Google sign-in or video playback in the final SoloHost container.

## Run

```bash
docker compose up -d --build
```

Health: `GET /api/health`  
Engine: `GET /api/engine/status`

## Limits

V10.7.0 explicitly enables JavaScript in the live WebKitGTK worker and uses a sanitized DOM snapshot + event bridge for the app viewport. Google, YouTube and other dynamic sites are best-effort; a successful HTTP response alone does not guarantee a usable page. CAPTCHA, anti-bot checks, DRM video, file upload and complex cross-origin widgets may still require **Open ↗**.



# SoloHost Browser v9.0.8 — Lightweight WebView + AI

A compact, bilingual (English/Vietnamese) browser shell for Pi SoloHost. The app uses the user's browser WebView/iframe for display and a small Node.js proxy to improve compatibility with sites that block iframe embedding. It does **not** run a separate Chromium browser engine in Docker.

## What changed in v9.0.8
- Rewrites common HTML resource URLs (scripts, images, posters, lazy-image attributes, `srcset`, stylesheet/icon/preload links) through the same-origin proxy.
- Rewrites CSS `url()` and `@import` references so relative fonts/background images/stylesheets resolve more reliably.
- Preserves the real document URL as the HTML base and injects a mobile viewport when missing.
- Reads HTML/CSS using the declared character encoding where supported.
- Validates redirect targets before each hop, limits redirects and response bytes while streaming, blocks private/reserved IPv4 and IPv6 destinations, and rejects URLs with embedded credentials.
- Adds baseline security headers and removes unnecessary camera/microphone/geolocation/payment permissions from the page frame.
- Keeps the existing tab UI, bookmarks, history, Universal AI, Feedback, provider settings, themes and EN/VI interface.
- Removes disabled legacy server-engine stubs that are not imported by the current client-WebView runtime.

## Runtime and endpoints
- Node.js/Express listens on `0.0.0.0:8080` by default.
- `GET /api/proxy?url=...` fetches a public HTTP(S) page/resource and rewrites HTML/CSS where appropriate.
- `GET /api/health`, `/health`, `/ready` report app health.
- AI and Feedback modules retain their existing routes and settings.
- Bookmarks/history are persisted through `lib/store.js` under the app data directory.

## Honest compatibility limits
This is a lightweight WebView/iframe + HTTP proxy, not a full browser engine. It cannot fully reproduce per-site browser cookies, service workers, WebSockets, DRM, all modern SPA behavior, CAPTCHA, login flows, or CORS-sensitive APIs. For login-heavy or sensitive pages, use the ↗ Open control to hand the URL to the user's full browser. Proxying also cannot safely or correctly emulate every website's security/session behavior.

## Build and test
```sh
npm install
npm test
npm start
```
The tests cover JavaScript syntax, core module contracts, common HTML/CSS rewriting and SSRF address-policy cases. Live website compatibility and the final SoloHost container must still be verified in the deployment environment.

Historical V7/V8 reports and release notes are retained for traceability; they describe older architectures and should not be read as the v9.0.8 runtime design.


## AI Agent mode (v10.4.0)

In the AI panel → Chat, tap 🤖 and give a task; the AI operates the open page step by step (open/search/click/type/scroll) with Allow/Deny for sensitive actions and a Stop button. Needs a configured AI provider (offline: simple commands only). Details, safety model and limits: `docs/AGENT.md`.


## V10.5.0 — Adaptive WebKit Bridge

- WebKitGTK is the preferred JavaScript execution engine when available; proxy remains the fallback.
- DOM snapshots are cloned before scripts are removed, so extracting a page no longer removes scripts from the live WebKit page.
- Login forms can forward text/password input events to the live page; password values are not copied into HTML snapshots or diagnostics.
- Website cookies can persist in `/app/data/browser-profile/cookies.sqlite` (the SoloHost data volume). Set `SOLOHOST_WEBKIT_PERSIST_COOKIES=0` to disable persistence.
- Bridge render audits log only structural counts (text length, forms, controls, media, iframes, links); AI compatibility checks receive those counts, not page text, credentials, cookies or tokens.
- This is still a DOM-snapshot bridge, not a full pixel-native browser surface. DRM-protected streaming, CAPTCHA and anti-embedded-webview checks may still require Open ↗.


## V10.6.0 — JavaScript and IPC recovery

- Explicit WebKit JavaScript setting; live scripts are not removed during snapshot extraction.
- Serialized IPC queue prevents requests waiting behind a slow page load from timing out before execution.
- Worker timeout recovery and per-session navigation coalescing reduce stale navigations and repeated fallback loops.
- Temporary proxy fallback can recover to WebKit; session tokens are redacted from logs.
- Run `npm test` before packaging. Live Google/YouTube behavior must still be verified in the SoloHost runtime.


## V10.7.0 — Empty-content and recursive viewport recovery

- Fixed a critical URL-sync bug: the internal `/api/browser/sessions/:id/view` iframe URL is no longer mistaken for the actual website URL. This prevented reload/agent actions from navigating back into the browser's own viewport endpoint.
- Server rejects same-host session view/state/content/navigation/event API URLs as navigation targets (`internal_url_not_navigable`) to prevent recursive self-fetches.
- Empty or CSS-only HTML remains empty; sanitization no longer adds bridge CSS to an empty response and then falsely reports `hasContent=true`.
- Content readiness checks recognize meaningful text, controls, links, images, media and worker audit metrics. Blank responses now trigger a clean fallback instead of being reported as successful pages.
- Clears prior-page snapshot state at navigation start so a failed page cannot leave stale content masquerading as the current page.
- Added regression tests for empty HTML, CSS-only documents, media-only pages, and internal viewport navigation guards.


## V10.8 — Backend-owned AI Panel browser actions

The Browser Agent now runs as a backend task against the authenticated browser session. The UI sends the task, polls progress, displays step results, and asks the user to confirm sensitive actions. It does not inspect the iframe DOM or directly click/type in the page. Backend actions use the WebKit worker/DOM Bridge; the viewport receives updated sanitized snapshots from the same session.

Supported task patterns include opening URLs, web/search queries, clicking links and controls, filling non-secret fields, selecting options, scrolling, reading long pages in chunks, summarizing/extracting visible page information, and diagnosing browser logs. Passwords, OTPs, card data and other secrets are never supplied to the agent. Sensitive actions require user confirmation.

Compatibility note: WebKitGTK is the backend engine, not Chromium. CAPTCHA, DRM, anti-bot pages, and some highly dynamic/cross-origin iframe content may still require opening the page in an external browser. The frontend snapshot intentionally does not execute website scripts in the SoloHost origin.
