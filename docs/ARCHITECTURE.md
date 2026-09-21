# Architecture assessment

## What works today (preserved)

- Optional SoloHost hub (`server.js`) for app discovery and local app routes
- Freeform web UI for the hub home surface
- Bookmarks/history JSON or SQLite fallback on the hub
- No host container-engine socket
- Health endpoint on the hub

## What limited compatibility

The hub used an HTML gateway / iframe path for the public web.
Large sites (Google, Facebook, captchas, media, WebSocket, WebRTC)
are designed for a real browser engine, not a rewritten proxy.

## What is preserved

- Hub code, Docker files, SoloHost kit
- Visual identity of the start surface
- Optional app launcher via HTTP only

## What was replaced

Internet rendering is no longer the hub proxy.
The Windows product uses WebView2 (Chromium) as a native process.

## Migration

1. Keep the Node hub as an optional SoloHost service.
2. Ship `native/windows` as the real browser.
3. Detect SoloHost only after the engine can browse.
