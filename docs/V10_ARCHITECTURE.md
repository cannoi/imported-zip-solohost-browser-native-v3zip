# SoloHost Browser V10 — Architecture

## SoloHost runtime facts

- App is a Docker web service on HTTP (PORT=8080).
- User opens the app in Pi Browser / remote browser (often phone → public IP).
- SoloHost does not attach a host display or native window bridge for that remote user.
- No docker.sock, no privileged mode.

## Why pure WebKitGTK is not the default display path

WebKitGTK renders into a native GTK window inside the container.
The SoloHost user views an HTML page over HTTP. A GTK window cannot appear inside that remote page without a display transport:

| Transport | Status |
|-----------|--------|
| Embed GTK in iframe | Impossible |
| Xvfb + x11vnc + noVNC | Rejected as default (remote desktop) |
| CDP JPEG screencast | Rejected earlier |
| GTK Broadway | Experimental; not production default |
| WebView2 / .exe | Rejected (not SoloHost web app) |

**Conclusion:** Claiming WebKitGTK native display while only showing iframe HTML would be false.

## V10 engine mode (honest)

User browser → SoloHost Browser UI (tabs, AI, Feedback, Logs)
  → Viewport: PROXY (default) | DIRECT iframe when allowed | EXTERNAL ↗

Default: hybrid-proxy. Not full Chrome/WebKit parity. Not DRM/Widevine by default.

## Future

If SoloHost adds a documented native display bridge, lib/engine/ can host WebKitGTK + IPC without rewriting the Node UI.
