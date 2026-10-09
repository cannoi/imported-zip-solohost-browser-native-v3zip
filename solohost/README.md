# SoloHost Browser package

Build this application from the project root Dockerfile. The v9 client-WebView design uses the host/browser iframe for page rendering and a lightweight Node.js HTTP proxy for compatibility; it does not start a separate Chromium/WebKit engine inside Docker.

Keep the SoloHost config options and app data volume intact when updating.
