# SoloHost WebKit Engine — Prototype

This is the first native engine layer for the post-Chromium SoloHost Browser.
It uses WebKitGTK inside the existing Docker/X11 display architecture.

The Node browser shell remains responsible for tabs, history, bookmarks, AI,
network status, SoloHost integration and the HTTP/WebSocket API. This native
process owns only web rendering and basic browser navigation.

Control protocol (localhost TCP, default port 9333):
- `NAVIGATE <url>`
- `BACK`
- `FORWARD`
- `RELOAD`
- `STOP`
- `QUIT`

This is deliberately a prototype. Production hardening, downloads, permissions,
media policy, multiple tabs, process isolation and WebKit-specific input APIs
come in later phases.
