# Phase 2 — Interactive DOM Bridge

## API contract

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | /api/browser/sessions | — | Create session → `{sessionId,token,backend}` |
| POST | /api/browser/sessions/:id/navigate | X-Session-Token | Load URL in session |
| GET | /api/browser/sessions/:id/state | token | URL/title/loading |
| GET | /api/browser/sessions/:id/content | token | JSON + sanitized html |
| GET | /api/browser/sessions/:id/view | token query | HTML document for iframe |
| POST | /api/browser/sessions/:id/events | token | click/input/submit/scroll/navigate |
| DELETE | /api/browser/sessions/:id | token | Close |

## Security

- Site JS stripped before view; CSP `script-src 'none'`
- Token required; rate limited
- SSRF via assertPublicHttpUrl
- Sessions isolated; TTL 30m

## Limits

- Proxy backend: click on links works via map; complex JS forms limited without WebKit
- WebKit backend: full dispatch when engine ready (Docker image)
- Media/CSS from absolute base href; some assets may fail CORS

## Tests

- test-bridge.js: sanitize, annotate, auth, navigate, destroy
