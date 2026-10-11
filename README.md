# SoloHost Browser V10.6.0

Lightweight private browser for **Pi Network SoloHost**.

## Engine (honest)

**Mode:** hybrid-proxy (Node UI + same-origin HTML proxy in an iframe).

Native **WebKitGTK cannot** paint into the remote SoloHost web page without a display transport. See `docs/V10_ARCHITECTURE.md`.

## Features preserved

Address bar, tabs, back/forward/home/reload, bookmarks, history, AI panel, Feedback, Settings, Logs.

## Run

```bash
docker compose up -d --build
```

Health: `GET /api/health`  
Engine: `GET /api/engine/status`

## Limits

V10.6.0 explicitly enables JavaScript in the live WebKitGTK worker and uses a sanitized DOM snapshot + event bridge for the app viewport. Google, YouTube and other dynamic sites are best-effort; a successful HTTP response alone does not guarantee a usable page. CAPTCHA, anti-bot checks, DRM video, file upload and complex cross-origin widgets may still require **Open ↗**.



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
