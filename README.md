# SoloHost Browser 7.3.0 — Media Engine

A lightweight Docker browser for Pi SoloHost built around a native WebKitGTK rendering engine.

The Node application is the browser shell and SoloHost integration layer. The native WebKit engine renders websites inside an isolated X11 display; no Chromium, CEF, WebView2 or CDP runtime is required.

## Runtime
- WebKitGTK native rendering engine
- Xvfb display
- x11vnc + noVNC display transport
- GStreamer media foundation
- Node.js browser shell/API
- Persistent profile under `/app/data/webkit-profile`
- HTML5 media controls for play/pause, mute, volume, captions toggle and video fullscreen
- GStreamer runtime with build-time checks for common H.264/AAC/MP3/VP8/VP9/Vorbis/Opus elements
- Conservative autoplay policy: user gesture required by default

## Scope
The current core targets normal web pages, JavaScript, HTML5 media, social/video sites, real native tabs, persistent browsing, downloads and browser recovery. DRM, full codec coverage, permission UI, PDF/external protocol handlers and the final native display transport are validated incrementally rather than being falsely assumed.


### V7.4 — File & Protocol Engine
- Safer scheme policy for HTTP(S), `about:`, `data:`, `blob:`, and profile-scoped `file:` URLs.
- Native WebKit navigation also enforces the scheme policy.
- Downloads page at `/downloads` and JSON list at `/api/files/downloads`; downloads are served as attachments.
- FTP, `javascript:`, `vbscript:`, `intent:`, and external `mailto:`, `tel:`, `magnet:` handlers are blocked by design. WebSocket/WebRTC are supported as page APIs rather than address-bar URLs.
- See `docs/ARCHITECTURE.md` for limitations and runtime validation requirements.


## v7.5.0 — Security & Privacy foundation

- Added persisted security settings and `/security` UI for site permission preferences, navigation safety, private-network blocking, download policy and privacy preferences.
- Added dangerous-scheme/credential checks and profile-scoped `file:` navigation policy.
- Native WebKit blocks new-window popup actions by default, denies website permissions unless an origin has an explicit grant, and cancels downloads when policy is set to `block`.
- Insecure active content remains disabled; profile data remains under the configured browser profile.
- Limitations: camera and microphone grants are coupled in this engine version; tracker blocklists, real third-party-cookie controls, automatic clear-on-exit, fully isolated private tabs, a native download confirmation prompt, and complete popup allow mode are not implemented/certified yet. Private-network blocking is a host-pattern guard, not a complete DNS-rebinding/redirect defense. Runtime native compilation and browser validation must be performed in Docker/SoloHost.

## v7.6.0 — Performance observability
- `GET /api/performance` reports process memory/CPU samples, cgroup memory, tab count and tracked browser/display process RSS.
- `node scripts/benchmark.js http://127.0.0.1:8080 30` samples API latency percentiles and writes a JSON report to stdout.
- This release deliberately does not claim measured page-load, FPS, input-latency, media-buffering, or noVNC bandwidth gains; those require the deployed SoloHost runtime and comparable before/after runs.
