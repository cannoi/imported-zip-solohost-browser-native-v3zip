# SoloHost Browser — Diagnostic (from source)

## Architecture summary

SoloHost Browser is a **Docker web app** (Express + static `public/`):

1. **UI shell** (`public/index.html`, `public/app.js`) — omnibox, tabs, themes, AI FAB.
2. **Display surface** — a single HTML **`<iframe id="main-webview">`** (not WebView2, not CEF).
3. **Same-origin HTML/CSS proxy** — `GET /api/proxy?url=…` implemented in `lib/frame-proxy.js`, mounted in `server.js`.
4. **Navigation rule** — omnibox shows the real URL; iframe `src` is either:
   - direct **embed** URL (YouTube `/embed/…`), or
   - **`/api/proxy?url=` + encoded target** for general sites.

## Q1 — iframe, WebView2, or top-level?

**Answer: HTML iframe + optional same-origin proxy. Not WebView2. Not external top-level navigation of the target site.**

Evidence:

- `public/index.html` — `<iframe id="main-webview" name="main-webview" …>`
- `public/app.js` — `const frame = $('main-webview');` and `frame.src = frameSrc`
- `public/app.js` — `proxyFrameUrl` → `'/api/proxy?url=' + encodeURIComponent(url)`
- `server.js` — `app.get('/api/proxy', … handleProxy)`
- No WebView2, Edge WebView, or native host APIs appear in the tree.

The SoloHost **app** itself is loaded top-level inside Pi/SoloHost’s browser; **third-party sites** are not navigated top-level — they are shown inside the iframe (directly or via proxy).

## Q2 — Site iframe policy vs app navigation bugs?

**Primary: site anti-framing policies (X-Frame-Options / CSP frame-ancestors).**

Evidence the app already anticipates this:

- `lib/frame-proxy.js` header comment: strips frame-busting headers; rewrites links/forms into `/api/proxy`.
- `handleProxy` sets `Content-Security-Policy: frame-ancestors *` on **proxy responses** and removes `X-Frame-Options` on the **response to the iframe** (same-origin document controlled by SoloHost).

**Secondary / residual app limits (not “connection refused” root cause for Google/Facebook, but real):**

- SPA sites (YouTube home, TikTok FYP) need client JS + private APIs; HTML proxy cannot fully recreate them → special shells in `specialShell()`.
- Google full SPA vs `gbv=1` HTML mode tradeoff.
- Proxy does **not** implement a complete browser network stack (service workers, complex CORS for unproxied third-party APIs).

So: “refused to connect / refused to display in a frame” for **direct** iframe loads is the **site’s** framing policy. The proxy mitigates that for **public HTML** by serving a same-origin copy. It is **not** a legal universal bypass of all site security policies for authenticated SPAs.

## Q3 — Fix in web app, or require native host?

**Can improve inside the current SoloHost/Docker web app (Option A).**  
**Cannot** solve “full Chrome parity for every site” without a real browser engine (Playwright/Chromium stream, or native WebView) — which conflicts with the lightweight web-app constraint or with prior product decisions.

- **A** — Improve iframe + proxy + navigation: **compatible**, already partially implemented.
- **B** — True top-level navigation to external sites **leaves** the SoloHost app shell (unless SoloHost itself provides an outer navigation region — not present in this source).
- **C** — WebView2: **not** achievable by HTML/JS inside Docker alone; requires a Windows host app.

## Comparison

| Criterion | A iframe+proxy | B top-level region | C WebView2 |
|---|---|---|---|
| Change size | Small–medium | Medium (needs host support) | Large |
| Fixes anti-frame public HTML | Partial yes (proxy) | Yes (no iframe) | Yes |
| SPA / login apps | Limited | Better | Best |
| SoloHost/Docker web constraint | Fits | Only if SoloHost allows | Does not fit |
| Risk / ToS | Proxy may violate some ToS; not a session-phishing design | Low | N/A here |

## Recommendation

**Option A** — keep iframe shell; continue hardening same-origin proxy and UX (Open ↗ fallback).  
Do **not** switch to WebView2 solely to fix iframe blocking while the product must remain a SoloHost Docker web app.

### Limits (must state)

- Proxy is **not** a universal legal bypass of CSP/XFO for all sites.
- Authenticated, DRM, or heavy SPA experiences may require **↗ Open tab**.
- No claim of “works for all websites” without runtime proof on SoloHost.
