# SoloHost Browser 7 — Install

The container installs WebKitGTK and GStreamer as the web rendering/media foundation. Chromium/CEF/WebView2 are not part of the runtime.

Build the image with the supplied Dockerfile, then expose port 8080 through SoloHost. Persistent browser data is stored in `/app/data/webkit-profile`.
