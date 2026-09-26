# SoloHost Browser 5.0.0

- Replaced the noVNC/X11 desktop architecture with a native CEF/Chromium browser core.
- Added CEF off-screen rendering and a private WebSocket display/input transport.
- Added persistent Chromium profile storage.
- Added real browser navigation, tabs, mouse, keyboard, wheel, reload, back and forward controls.
- Removed Xvfb, x11vnc, noVNC and websockify from the runtime.
- Removed the legacy HTML website proxy path.
- Kept SoloHost app discovery, bookmarks and history services.
- Pinned CEF 152 / Chromium 152 in the Docker build.
