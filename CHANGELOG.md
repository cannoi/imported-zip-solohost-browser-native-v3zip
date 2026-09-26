# Changelog

## [6.2.2] - 2026-09-26
- Hide noVNC control bar, status, panels, and local/virtual cursor (show_dot=0 + injected CSS).
- x11vnc -nocursorshape so RFB does not draw a second cursor overlay.
- x11vnc -nocursor (was -nocursorshape) so no cursor is composited into the video frame at all.
- display-proxy now injects the hide-CSS/auto-connect script server-side into vnc.html itself, removing the brief flash of noVNC's connect dialog on first load.
- Sharper page rendering: Xvfb/Chromium baseline resolution raised from 1280x800 to 1920x1080, x11vnc -xrandr added, and the client now requests resize=remote (native resolution match) with quality=9/compression=0 instead of resize=scale, which was stretching a small fixed image and causing the blur.

# Changelog

## [6.2.1] - 2026-09-26
- Overlay "Page unavailable" was triggered by any CDP/WebSocket error, including attach races.
- Chromium flag --remote-allow-origins=* so Node can open DevTools WebSocket (Chrome 111+).
- CDP retries attach and creates a page via /json/new when /json/list is empty.
- Navigation also goes through POST /api/browser/navigate.
- Overlay no longer covers the live noVNC view.

# Changelog

## [6.2.0] - 2026-09-26
- Chromium no longer inherits HTTP(S)_PROXY from the container unless CHROMIUM_USE_PROXY=1 (Node https does not use those vars; Chromium does).
- Dropped --app=about:blank so kiosk can navigate to arbitrary HTTPS via CDP.
- Added --disable-setuid-sandbox next to existing --no-sandbox for Docker child/network process.
- GET /api/network/status reports container/Node/DNS/HTTPS/IPv4/IPv6/proxy/Chromium CDP navigation.

# Changelog

## [6.1.0] - 2026-09-26
- Architecture decision: A impossible in Pi Browser DOM; B too heavy for SoloHost default; D banned for display; C kiosk is default.
- Chromium starts --kiosk --app so the RFB stream is the page viewport, not a desktop window.
- docs/ARCHITECTURE.md and docs/BENCHMARK.md (all timings NOT_MEASURED here).

# Changelog

## [6.0.0] - 2026-09-26
- Production view is Chromium on Xvfb streamed with noVNC (RFB), not CDP JPEG/canvas.
- HTTP listens on 0.0.0.0:8080 before Chromium starts.
- /health is process liveness; /ready and /api/browser/status report engine state.
- Persistent profile directory /app/data/chromium-profile with writable fallback.
- CDP kept as control plane for navigation and AI only.
- Default Docker image still does not compile CEF. native/ CEF sources retained.

# Changelog

## [5.1.0] - 2026-09-26
- SoloHost import no longer compiles CEF during docker build (that hung builder scripts).
- HTTP server starts immediately. Chromium engine starts on first use.
- System Chromium + CDP is the default runtime; CEF binary is used only if present.
- Assist panel: local Ollama first, then OpenAI-compatible / Anthropic when keys exist.
- Compose no longer pins a remote GHCR image.

# Changelog

## 5.0.0 — Chromium-based Browser
- Replaced the virtual desktop/noVNC architecture with a native CEF/Chromium browser core and OSR WebSocket display transport.
- Removed the external website HTML proxy.
- Added persistent Chromium profile storage and real browser input/navigation.
