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
