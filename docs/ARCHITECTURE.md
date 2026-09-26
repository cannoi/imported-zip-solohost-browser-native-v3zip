# Architecture — SoloHost Browser 6.1

## Hard constraint

SoloHost Browser is a web app opened inside Pi Browser.

Pi Browser cannot host a native Chromium compositor surface in its DOM.
Pixels from container Chromium must travel over HTTP/WebSocket (or WebRTC).

The product therefore cannot be an in-process embedded Chromium like Win32 WebView.
noVNC is not "embedded Chromium". It is a live view of a real Chromium process.

## Pipelines

Display:

    system Chromium (kiosk, one process)
      -> Xvfb
      -> x11vnc RFB
      -> websockify + noVNC
      -> iframe #browser-view

Page input: noVNC -> VNC -> X11 -> Chromium
Control / AI: CDP :9222
HTTP: Node 0.0.0.0:8080 first, engine later

## A Native CEF surface

Prebuilt CEF can paint a native window. It still needs a pixel transport to reach Pi Browser.
Official linux64 CEF runtimes are hundreds of MB. Compiling CEF in Docker is rejected.

Verdict: keep native/ as history. Not default runtime.

## B WebRTC / Selkies-style

Better motion latency on paper. Needs GStreamer, often GPU, sometimes TURN.
Desktop images often ~1 GB. ICE/UDP frequently fails behind a single SoloHost HTTP proxy.

Verdict: not default. Revisit only with GPU and a proven one-port path.

## C X11 + VNC + noVNC kiosk

Debian packages only. One TCP port. Works through SoloHost proxy.
Chromium is real. RFB is weaker than WebRTC for video FPS.

Verdict: default. Chromium runs kiosk/fullscreen so the stream is the page, not a desktop.

## D CDP JPEG / canvas

Rejected for display. CDP is control plane only.

## Choice

C kiosk-optimized: real engine, one port, no CEF compile, smallest extra deps among live-view options.
Not a local browser widget.

## Profile

/app/data/chromium-profile with writable fallback.

## GPU

CHROMIUM_GPU=0 uses SwiftShader. Otherwise Chromium default. No NVIDIA assumption.
