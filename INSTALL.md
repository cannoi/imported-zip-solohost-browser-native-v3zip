# SoloHost Browser 7 — Install

The container installs WebKitGTK and GStreamer as the web rendering/media foundation. Chromium/CEF/WebView2 are not part of the runtime.

Build the image with the supplied Dockerfile, then expose port 8080 through SoloHost. Persistent browser data is stored in `/app/data/webkit-profile`.


V7.3 installs GStreamer base/good/bad/ugly/libav and checks required decoder elements during image build. By default, media playback requires a user gesture. Autoplay can be enabled explicitly with `SOLOHOST_MEDIA_AUTOPLAY=1`; keep the default for normal interactive use. DRM/Widevine and audio forwarding through noVNC are not included.
