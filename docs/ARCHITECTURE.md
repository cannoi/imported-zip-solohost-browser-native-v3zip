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


## V7.3 Media engine

WebKitGTK remains the rendering engine. GStreamer runtime includes base/good/bad/ugly/libav/GL plugins and a build-time `gst-inspect-1.0` check for common media elements. WebKit settings enable HTML media, MediaSource, WebAudio and inline playback; autoplay requires a user gesture by default and can be explicitly changed with `SOLOHOST_MEDIA_AUTOPLAY=1`. The shell exposes play/pause, mute, volume, subtitle-track toggle and video fullscreen controls that act on media elements in the active page. Native site controls remain available.

This is source-level/media-stack preparation, not proof that every YouTube stream or every codec profile works. DRM/Widevine is not certified. The current Xvfb/noVNC transport carries the browser image and input but does not provide an audio stream to the host client; audible remote playback therefore remains a separate transport task. Camera/microphone permission remains denied by default.


## V7.4 File & Protocol Policy
- Navigable: HTTP, HTTPS, about:, data:, blob:, and file: URLs inside `SOLOHOST_BROWSER_DATA` only. `data:` and `blob:` are primarily page/resource URLs and remain subject to WebKit origin rules.
- Page capabilities: WebSocket and WebRTC are web APIs/subresource protocols, not standalone address-bar schemes. WebRTC media capture remains disabled unless explicitly configured, and permissions are denied by default.
- Blocked: javascript:, vbscript:, intent:, FTP legacy navigation, and external mailto:/tel:/magnet: handlers. The container does not launch host OS applications or torrent clients.
- Downloads are stored in `SOLOHOST_DOWNLOADS`; the `/downloads` page and `/api/files/downloads` endpoints only expose files from that directory. Downloads are delivered as attachments, never inline executable content.
- Uploading files to websites uses normal HTML file inputs where GTK/WebKit supports the chooser. A host-to-container file import UI is not implemented in this release.
- PDFs and common media/document formats are rendered by WebKit/GStreamer only when the relevant runtime handler/decoder is available. This source release does not certify all MIME types, FTP support, DRM/Widevine, or every codec.


## v7.5.0 — Security & Privacy foundation

- Added persisted security settings and `/security` UI for site permission preferences, navigation safety, private-network blocking, download policy and privacy preferences.
- Added dangerous-scheme/credential checks and profile-scoped `file:` navigation policy.
- Native WebKit blocks new-window popup actions by default, denies website permissions unless an origin has an explicit grant, and cancels downloads when policy is set to `block`.
- Insecure active content remains disabled; profile data remains under the configured browser profile.
- Limitations: camera and microphone grants are coupled in this engine version; tracker blocklists, real third-party-cookie controls, automatic clear-on-exit, fully isolated private tabs, a native download confirmation prompt, and complete popup allow mode are not implemented/certified yet. Private-network blocking is a host-pattern guard, not a complete DNS-rebinding/redirect defense. Runtime native compilation and browser validation must be performed in Docker/SoloHost.

## v7.6.0 — Performance observability
- The engine manager now publishes the PIDs of WebKit, Xvfb, x11vnc and websockify plus the active screen dimensions.
- `/api/performance` reports Node memory, an interval CPU sample, cgroup memory where available, tab count, and best-effort RSS for tracked process trees.
- The internal noVNC HTTP asset proxy reuses keep-alive connections. The WebSocket/VNC tunnel is unchanged.
- No forced lazy-loading or background-tab freezing is enabled: these can change site semantics, notifications, media playback and responsiveness. No speed or RAM reduction is claimed until a before/after run is captured on SoloHost.


## V7.7 Display Engine

```text
WebKitGTK (native render)
  → Xvfb framebuffer
  → x11vnc RFB (fps/wait/defer/ncache tuned)
  → websockify
  → noVNC iframe in SoloHost shell
```

Constraint: the SoloHost shell is opened inside Pi Browser, so a native WebKit surface cannot be composed into the DOM. A transport remains mandatory.

Default mode: `SOLOHOST_DISPLAY_MODE=novnc`.
Optional off: `SOLOHOST_DISPLAY_MODE=off` (engine only; no view stream).

Alternatives (WebRTC, KasmVNC, offscreen WS frames) stay documented experimental until SoloHost benchmarks show net gain on CPU, RAM, latency, and image size.


## V7.8 AI Browser

```text
User → SoloHost Browser shell → AI Assistant (optional)
  skills: search | summarize | explain | translate | navigate | extract | assist
Providers (priority): Personal AI Hub → Ollama local → OpenAI-compatible → Anthropic
```

AI never owns rendering. WebKit remains the engine. If no provider is available, Assist returns a soft error and the browser continues.
