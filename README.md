# SoloHost Browser 7

A lightweight Docker browser for Pi SoloHost built around a native WebKitGTK rendering engine.

The Node application is the browser shell and SoloHost integration layer. The native WebKit engine renders websites inside an isolated X11 display; no Chromium, CEF, WebView2 or CDP runtime is required.

## Runtime
- WebKitGTK native rendering engine
- Xvfb display
- x11vnc + noVNC display transport
- GStreamer media foundation
- Node.js browser shell/API
- Persistent profile under `/app/data/webkit-profile`

## Scope
The current core targets normal web pages, JavaScript, HTML5 media, social/video sites, real native tabs, persistent browsing, downloads and browser recovery. DRM, full codec coverage, permission UI, PDF/external protocol handlers and the final native display transport are validated incrementally rather than being falsely assumed.
