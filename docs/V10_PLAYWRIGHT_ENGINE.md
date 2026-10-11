# V10.9 — Playwright Chromium Engine

## Why

WebKitGTK in Docker was slow/unstable (D-Bus, js_timeout). Playwright Chromium runs **full JavaScript, CSS, network, cookies** server-side.

## Display model

```
User UI (SoloHost web)
  → DOM Bridge snapshot (HTML after JS ran in Chromium)
  → events (click/type/submit) → Playwright page
```

Not VNC. Not CDP screencast as primary path.

## Login / passwords

Typing via bridge `input` events fills fields **inside Chromium context**. Values are **not logged**. Cookies stay in the Playwright browser context for that session.

Meta/Netflix may still force EXTERNAL policy.

## Adaptive modes (content-router)

| Mode | Use |
|------|-----|
| ENGINE | Playwright (SPA, modern sites) |
| PROXY | HTML proxy (articles) |
| EMBED | YouTube embed |
| EXTERNAL | DRM / Meta policy |
| LOGIN | ENGINE preferred + external help |

## Enable

Dockerfile uses `mcr.microsoft.com/playwright`. Env `SOLOHOST_PLAYWRIGHT=1`.
