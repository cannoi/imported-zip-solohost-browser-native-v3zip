# Phase 1 — WebKitGTK Backend Worker

## Delivered

- `native/webkit-worker/worker.py` — JSON-lines IPC, sessions, navigate, status
- `lib/engine/webkit-manager.js` — spawn, timeout, restart, shutdown, private Xvfb
- HTTP API (no UI change):
  - `GET /api/engine/status`
  - `POST /api/engine/session`
  - `POST /api/engine/session/:id/navigate` `{url}`
  - `GET /api/engine/session/:id`
  - `DELETE /api/engine/session/:id`
- Dockerfile: `node:20-bookworm-slim` + webkit2gtk + xvfb + python3-gi
- Proxy remains interactive fallback; viewport **unchanged**

## Tests

| Test | Result |
|------|--------|
| `node test.js` | PASS |
| `node test-engine.js` (protocol, soft-fail without GTK) | PASS |
| Manager soft-fail without Xvfb | PASS |
| Full WebKit navigate example.com | NOT TESTED (no WebKit/Xvfb on sandbox; needs Docker image) |
| Docker build | NOT TESTED (no Docker daemon) |
| SoloHost install | NOT TESTED ON SOLOHOST |

## Security

- Worker only accepts stdin from parent Node
- Loopback blocked unless `SOLOHOST_WEBKIT_ALLOW_LOOPBACK=1`
- Navigate API reuses `assertPublicHttpUrl`
- No AI tokens in page JS

## Rollback

`SOLOHOST_WEBKIT=0` or previous hybrid-only zip.
