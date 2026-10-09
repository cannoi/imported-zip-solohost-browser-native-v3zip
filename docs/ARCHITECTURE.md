# SoloHost Browser 8 — Architecture (Phase 1)

## Goal
A small, private, bilingual app that turns the open web into clean, readable content, with an optional AI assistant that answers in the user's language.

## Pipeline
```text
SoloHost shell (public/*, unchanged)
  → Node HTTP/WS gateway (server.js, browser-gateway.js)
  → engine-control (navigation + security policy)
  → chromium-engine (tabs, history, watchdog)
  → ContentExtractor
       Playwright Chromium (headless) → goto(domcontentloaded) → short network-idle settle
       page.on('response') → media[] (.m3u8 / .mp4)
       page.content() → jsdom → metadata + @mozilla/readability → sanitise → clean_html / raw_text
  → reader-view (/view, inside the shell's existing iframe)
  → AI adapter (getContext supplies the extracted page text to the assistant)
```
The old WebKitGTK engine, Xvfb, x11vnc, websockify/noVNC and the canvas/VNC capture are removed. `/api/display/status` still answers (mode `off`) so older clients do not break.

## Security
- Navigation policy and security settings (v7.4/v7.5) are applied before Chromium is touched.
- Network layer: every request made by the page is checked; private/loopback/link-local hosts (including hostnames that resolve to them) are aborted; images and fonts are not downloaded by default.
- Fresh isolated browser context per extraction; downloads and service workers disabled.
- Article HTML is sanitised after Readability; the reader page uses a strict CSP with one nonce'd script.
- Known gap: Chromium performs its own DNS lookup, so a DNS-rebinding attacker can still race the host check.

## Media
Phase 1 only *detects* HLS (`.m3u8`) and MP4 streams requested by the page. Playback, DRM and audio are out of scope until a later phase.

## File & download policy (v7.4)
Downloads stored in `SOLOHOST_DOWNLOADS` are listed at `/downloads` and served as attachments. Navigation to `file:`, `data:` and `blob:` URLs is not supported by the Phase 1 extractor.

## AI
AI never owns rendering. With no provider configured, the offline guide answers in Vietnamese or English; with a provider, the assistant receives the page title, URL, language and the first ~4000 characters of extracted text, so summarise / explain / translate work on the real article.
