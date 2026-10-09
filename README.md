# SoloHost Browser 8.0 — Phase 1: Chromium Reader Engine

A lightweight, private, bilingual (English + Tiếng Việt) browser for Pi SoloHost with an optional AI assistant.

**Phase 1** replaces the native WebKitGTK engine and the Xvfb/x11vnc/noVNC pixel stream with **headless Chromium (Playwright)** plus **Mozilla Readability**. Every page is rendered by Chromium (JavaScript included), cleaned into a readable article, and shown in the existing SoloHost shell through Reader mode.

## Runtime
- Node.js shell/API (unchanged): tabs, bookmarks, history, downloads, security policy, SoloHost app catalog
- `lib/content-extractor.js` — `ContentExtractor`: Playwright Chromium → `page.content()` → jsdom + Readability
- `lib/chromium-engine.js` — tab/history state, lifecycle, watchdog, restart with back-off
- `lib/reader-view.js` — serves the article at `/view` (the iframe the shell already embeds)
- Persistent profile folder `/app/data/webkit-profile` (name kept so existing volumes keep working)
- Base image `mcr.microsoft.com/playwright:v1.40.0-focal`; no compiler, GTK, WebKitGTK, GStreamer, Xvfb, VNC or noVNC

## What `extract(url)` returns
`title, author, site_name, favicon, published_at, lang, excerpt, clean_html, raw_text, word_count, reading_minutes, readable, media[], final_url, http_status, content_type, kind, extracted_at, duration_ms`

`media[]` lists `.m3u8` / `.mp4` responses seen on the network (`{url, type, content_type, status, size}`).

## API
| Route | Purpose |
|---|---|
| `POST /api/extract` `{url}` | One-shot extraction, no tab involved |
| `GET /api/browser/content[?id=][&summary=1]` | Content of the active/selected tab (or just its revision) |
| `POST /api/browser/navigate` `{url}` | Navigate the active tab (shell uses this) |
| `GET /view/` | Reader page for the active tab (EN/VI by `Accept-Language`) |
| `GET /ready`, `/api/browser/status` | Engine state (`ready` once Chromium is launched) |

## Test
```bash
npm install
npm test                       # unit + contract tests (also parses a real HTML fixture with jsdom/Readability)
npm run smoke:extract -- https://example.com   # real Chromium check — run inside the built container
```

## Configuration (optional env)
`SOLOHOST_NAV_TIMEOUT_MS` (30000) · `SOLOHOST_EXTRACT_SETTLE_MS` (2500, wait for network idle after DOMContentLoaded) · `SOLOHOST_EXTRACT_CONCURRENCY` (3) · `SOLOHOST_EXTRACT_BLOCK` (`image,font`) · `SOLOHOST_CHROMIUM_PATH` · `SOLOHOST_USER_AGENT`

## Security (unchanged policy, enforced for Chromium too)
- Only `http`/`https` pages are extracted. `javascript:`, `ftp:`, `mailto:` … are rejected by the existing navigation policy.
- Private network / localhost is blocked for the page **and every sub-request** (hostnames are also DNS-resolved and checked). This narrows, but does not fully remove, DNS-rebinding risk.
- Fresh browser context per extraction (no shared cookies), downloads and service workers disabled, article HTML is sanitised (scripts, iframes, forms, `on*` handlers, `javascript:` URLs removed) and the reader page is served with a strict CSP.

## Limits of Phase 1
Reader mode shows article text and images only: no interactive sites, logins, forms, video playback or Find-in-page yet. Video/stream links are *detected and listed*, not played. See `V8.0_PHASE1_REPORT.md`.

---
Earlier releases (v7.x: WebKitGTK + noVNC) are documented in `CHANGELOG.md` and the `V7.x_UPGRADE_REPORT.md` files.
