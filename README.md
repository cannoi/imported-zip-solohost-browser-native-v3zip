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
