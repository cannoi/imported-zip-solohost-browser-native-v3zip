# SoloHost Browser 5 — Chromium-based

A real Chromium-based browser application for Pi SoloHost. The browser engine is Chromium hosted through CEF (Chromium Embedded Framework). The web UI is only the browser chrome; websites are rendered by Chromium itself.

## Architecture

- Chromium/CEF native browser core
- CEF off-screen rendering (OSR)
- WebSocket display/input transport
- Persistent Chromium profile under `/app/data/chromium`
- Direct Internet navigation from Chromium; no HTML rewrite/proxy
- Node gateway for SoloHost UI and app discovery
- No Docker socket
- No Xvfb, x11vnc, noVNC, websockify, or WebView2

CEF officially supports windowless/off-screen rendering by supplying a pixel buffer and accepting browser input events from the host application. It also uses Chromium's multi-process architecture. See the official CEF documentation.

## Build

The Docker build downloads a pinned CEF 152 binary distribution and compiles the native browser core. The image is therefore reproducible against the pinned CEF/Chromium release rather than an unpinned `latest` browser package.

## Runtime

Expose only the Node port 8080. The native browser core WebSocket listens on loopback inside the container and is never published externally.

## Data

`/app/data/chromium` stores the Chromium profile/cache. Cookies, local storage and other browser state can persist across container restarts.

## Important performance note

CEF OSR in the CPU-pixel-buffer mode is intentionally used here for browser isolation and portability. It is not the final GPU-shared-texture path. The protocol is isolated so a later accelerated shared-texture transport can replace the JPEG frame encoder without changing the browser UI/input API.
