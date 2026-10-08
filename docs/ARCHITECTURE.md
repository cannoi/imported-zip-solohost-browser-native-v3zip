# SoloHost Browser 7 architecture

## Goal
A real browser inside SoloHost Docker without Chromium/CEF/WebView2. The web engine is WebKitGTK; the application shell remains Node.js.

## Runtime

```text
SoloHost
  -> Node browser shell/API
  -> native WebKitGTK engine
  -> X11/Xvfb
  -> x11vnc
  -> websockify/noVNC
  -> Browser UI
```

The Node shell handles navigation commands, tabs, history, bookmarks, AI and SoloHost integration. The native engine owns web rendering. noVNC is only the display/input transport; it is not the web engine.

## Why WebKitGTK
WebKitGTK is a native web content engine available directly from Debian Trixie packages. Debian currently provides `libwebkit2gtk-4.1-0` and development headers for `libwebkit2gtk-4.1-dev`. citeturn1search0turn1search2

## 7.2 core implemented
- WebKitGTK persistent browser context with browser cache model.
- Real native tabs backed by multiple WebKitWebView instances; shared persistent profile, plus an ephemeral-context path reserved for private tabs.
- Engine watchdog, restart and profile-recovery backup.
- Navigation timeout, TLS/navigation error capture and blank/error state tracking.
- Download destination is restricted to the browser profile download area.
- WebKit subprocess sandbox enabled by default; `bubblewrap` is included in the runtime image.
- Find-in-page, zoom and fullscreen control paths are exposed through the native engine.
- Browser session metadata is restored by the SoloHost shell.

## Foundation limitations
The first release is deliberately a foundation. Full compatibility with every website, DRM/Widevine, every codec/container, downloads, permission prompts, printing, extensions and strong per-tab process policy require dedicated validation and additional work.
