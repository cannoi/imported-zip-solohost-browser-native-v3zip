# Build and release — SoloHost Browser 7

## Runtime architecture

The production runtime is a native WebKitGTK engine inside Docker. Chromium, CEF, WebView2 and CDP are not runtime dependencies.

## Build

The Dockerfile uses a multi-stage build. The builder installs WebKitGTK development headers and compiles `native/webkit-engine/solohost-webkit-engine`. The final image contains only the WebKitGTK runtime, GStreamer media runtime, Xvfb/x11vnc/noVNC/websockify and the Node application.

## Validation
1. Static Node tests pass.
2. Dockerfile contains no Chromium package.
3. Native engine source and CMake project exist.
4. Docker build must compile the native WebKit engine.
5. Container smoke test must confirm `/health` and `/ready`.
6. Browser smoke test must cover Google, YouTube, Facebook, audio/video playback and navigation.


V7.3 image builds additionally run `gst-inspect-1.0` checks for common media decoder elements. A successful static `npm test` does not replace the native C++ compile, Docker image build, or real-site playback test.


## v7.5.0 — Security & Privacy foundation

- Added persisted security settings and `/security` UI for site permission preferences, navigation safety, private-network blocking, download policy and privacy preferences.
- Added dangerous-scheme/credential checks and profile-scoped `file:` navigation policy.
- Native WebKit blocks new-window popup actions by default, denies website permissions unless an origin has an explicit grant, and cancels downloads when policy is set to `block`.
- Insecure active content remains disabled; profile data remains under the configured browser profile.
- Limitations: camera and microphone grants are coupled in this engine version; tracker blocklists, real third-party-cookie controls, automatic clear-on-exit, fully isolated private tabs, a native download confirmation prompt, and complete popup allow mode are not implemented/certified yet. Private-network blocking is a host-pattern guard, not a complete DNS-rebinding/redirect defense. Runtime native compilation and browser validation must be performed in Docker/SoloHost.

## v7.6.0 performance validation
Run `node scripts/benchmark.js http://127.0.0.1:8080 30` against the running container and save its JSON output. For valid before/after comparisons use the same SoloHost host, browser profile state, screen resolution, target URLs, tab count, warm-up period, and idle/browse/video scenario. The API benchmark alone does not measure render FPS, input latency, decoded-image memory, media rebuffering, or noVNC bandwidth.
