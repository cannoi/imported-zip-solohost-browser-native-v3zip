# SoloHost Browser V10 — Phase 0 Checkpoint

**Date:** 2026-10-10  
**Scope:** Inspect only — no large architecture changes applied.  
**Baseline version:** 10.0.0-hybrid-engine  
**Environment:** Ubuntu 24.04.4 LTS (dev sandbox), Node v24.15.0, **no Docker daemon**, **DISPLAY empty**.

---

## 1. Architecture hiện tại (từ mã nguồn)

```
┌─────────────────────────────────────────────────────────┐
│  User client (Pi Browser / Chrome / phone remote)       │
│  Opens SoloHost app URL (HTTP)                          │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP
┌──────────────────────────▼──────────────────────────────┐
│  Docker container (node:20-alpine)                      │
│  start.sh → node server.js  PORT=8080 HOST=0.0.0.0      │
│                                                         │
│  Express:                                               │
│   • static public/ (UI chrome, tabs, AI FAB)            │
│   • GET /api/proxy?url= → lib/frame-proxy.js            │
│   • history / bookmarks / diagnose / engine/status      │
│   • AI routes + Feedback routes                         │
│   • data/ volume (JSON store, app.log)                  │
│                                                         │
│  Viewport: <iframe id="main-webview">                   │
│   src = /api/proxy?url=<encoded>  (same-origin HTML)    │
└─────────────────────────────────────────────────────────┘
```

| Layer | Implementation | File |
|-------|----------------|------|
| UI shell | HTML/CSS/JS | `public/index.html`, `app.js`, `style.css` |
| Navigation | Client `navigate()` → iframe → proxy | `public/app.js` |
| Page load | Server fetch + header strip + link rewrite | `lib/frame-proxy.js` |
| SSRF | `assertPublicHttpUrl` (private IP, credentials) | `lib/frame-proxy.js` |
| Persistence | JSON under `/app/data` | `lib/store.js` |
| AI | Universal module + `app-adapter` | `lib/ai-module/*`, `lib/app-adapter.js` |
| Feedback | Hub-backed module | `lib/feedback-module/*` |
| Engine claim | `hybrid-proxy`, **not** WebKit native | `lib/engine/capabilities.js` |

**Not present:** WebKitGTK process, GTK window, VNC, CDP screencast, docker.sock, Playwright.

---

## 2. Entrypoint / packaging

| Item | Value |
|------|--------|
| Base image | `node:20-alpine` |
| CMD | `./start.sh` → `node server.js` |
| Port | `8080` |
| Health | `wget http://127.0.0.1:8080/api/health` |
| Volume | `solohost-browser-data:/app/data` |
| Config | `config_options.yml` → `fields: []` (no required secrets) |
| Labels | `pi.ui.primary: "true"` |
| Runtime user | `node` (non-root) |

---

## 3. Endpoints hiện có

| Method | Path | Role |
|--------|------|------|
| GET | `/api/health`, `/health`, `/api/ready` | Health |
| GET | `/api/engine/status` | Honest engine capabilities |
| GET | `/api/proxy?url=` | HTML frame proxy |
| GET/POST/DELETE | `/api/browser/history` | History |
| GET/POST/DELETE | `/api/browser/bookmarks` | Bookmarks |
| GET | `/api/browser/diagnose` | Log-based diagnosis |
| GET | `/api/browser/parse` | Compatibility stub / parse signal |
| POST | `/api/logs/client` | Client log ingest |
| * | `/api/ai/*`, `/api/feedback/*` | AI + Feedback modules |
| GET | `/` + static | UI |

---

## 4. Baseline tests (dev sandbox)

**Command:** `node test.js` + `node --check` on server/proxy/app/ai-panel.

| Result | Detail |
|--------|--------|
| PASS | package.json contracts |
| PASS | required files present |
| PASS | proxy rendering + SSRF regression checks |
| PASS | JS syntax (`server.js`, `frame-proxy.js`, `app.js`, `ai-panel.js`) |
| NOT RUN | Docker image build (no Docker daemon in this sandbox) |
| NOT RUN | Live SoloHost install |
| NOT RUN | Real Google/YouTube/Facebook interaction in this session |

**Known product issues (from prior production logs, not re-proven here):**

1. Google SPA/interstitial → blank or fallback when scripts stripped (`proxy.google_interstitial` / `proxy.google_fallback`).
2. DuckDuckGo `/l/?uddg=` historically returned 400 (unwrap exists in code; needs runtime retest).
3. Facebook/Meta often `proxy.blocked`.
4. DRM/streaming sites partial at best in pure HTML proxy.
5. `127.0.0.1` in proxy is container loopback, not SoloHost host PC.

---

## 5. WebKitGTK feasibility (evidence)

### A. Load page *inside* a WebKitGTK process (container)

| Check | Evidence |
|-------|----------|
| Host OS | Ubuntu 24.04 — `libgtk-3.so.0` present |
| DISPLAY | **empty** — no interactive display on this sandbox |
| Apt packages | `libwebkit2gtk` family available on Ubuntu apt (host) |
| Docker image | **Alpine** — no WebKitGTK installed; would need Debian/Ubuntu base + large deps |
| Docker daemon | **Not available** in this sandbox — cannot build/run image here |

**Feasible in principle:** Yes, install WebKitGTK in a Debian-based image and load URLs headless or with Xvfb.

### B. Deliver interactive DOM/pixels to SoloHost user over HTTP

| Path | Allowed by prompt? | Feasible for SoloHost remote UI? |
|------|--------------------|----------------------------------|
| Native GTK window on user desktop | N/A | SoloHost user is remote browser, not container display |
| Embed GTK in iframe | — | **Impossible** |
| VNC / noVNC | **Forbidden** | — |
| CDP screencast | **Forbidden** | — |
| docker.sock | **Forbidden** | — |
| Custom “Interactive Web Bridge” (DOM events ↔ WebKit) without VNC/CDP stream | Research needed | **No proven open protocol** that streams full interactive WebKit into a remote browser without a display transport |

**Critical distinction:**

- **Load in WebKitGTK** = process can fetch/render/JS-execute a page.
- **Interactive HTTP viewport** = remote user’s browser must *see and control* that page.

Without VNC/CDP/Broadway-like transport, WebKitGTK output does **not** reach the SoloHost HTTP client.

**Verdict:**

| Capability | Status |
|------------|--------|
| Install WebKitGTK in future image | PARTIAL / possible (Debian base) |
| Use WebKit as server-side worker (extract, title, offline AI context) | Possible without display |
| Use WebKit as **primary interactive viewport** for SoloHost web users | **BLOCKED** under constraints (no VNC/CDP/remote desktop, no native display bridge) |

---

## 6. Proposed minimal architecture (for later phases — not implemented)

```
Node.js Gateway (existing Express UI + APIs)
        │
        ├── WebKitGTK Worker (optional, subprocess)
        │     • navigate, get title/url, extract text
        │     • NO pixel stream to client
        │
        ├── Interactive Web Bridge (TBD — only if a non-VNC protocol is proven)
        │
        └── HTTP Viewport (current iframe + proxy)  ← remains default interactive path
```

### Draft API contracts (future, not implemented)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/engine/status` | **Exists** — mode, limits |
| `POST /api/engine/navigate` | Worker-only navigate (if worker exists) |
| `GET /api/engine/snapshot` | Text/metadata only — **not** framebuffer |
| `WS /api/engine/events` | url/title/loading events (no pixels) |

Any future worker must:

- Authenticate IPC (token/local socket).
- Not expose admin APIs to third-party sites.
- Keep SSRF on server-side fetches.
- Clean up child processes on shutdown.

---

## 7. Related files / deps / risks / rollback

### Files related to a future engine phase

| Path | Role |
|------|------|
| `server.js` | Gateway |
| `lib/frame-proxy.js` | Current interactive path |
| `lib/engine/capabilities.js` | Capability report |
| `public/app.js` | Viewport control |
| `Dockerfile` | Base image + deps |
| `docs/V10_ARCHITECTURE.md` | Constraints |

**Do not touch** (unless required): AI module core, Feedback Hub tokens, store schema, `config_options.yml` fields unless migration provided.

### Dependencies if WebKit worker later

- Base image change: Alpine → Debian slim (or multi-stage).
- Packages: `libwebkit2gtk-4.1-0`, GObject introspection / optional GStreamer.
- Image size and RAM increase (significant).
- Startup time and crash recovery for native child.

### Risks

| Risk | Mitigation |
|------|------------|
| Claiming “native browser” while UI is still iframe | Keep `capabilities.js` honest |
| Breaking AI/Feedback while changing Dockerfile | Regression tests; no module deletion |
| SSRF if worker fetches private hosts | Reuse `assertPublicHttpUrl` policy |
| Orphan WebKit processes | PID tracking + shutdown hooks |
| SoloHost smoke test timeout | Health endpoint must stay fast |

### Rollback

1. Revert to zip `solohost-browser-v10.0.0-hybrid-engine.zip` / tag 10.0.0.
2. Or set `SOLOHOST_ENGINE=proxy` and disable worker spawn.
3. Data volume `/app/data` independent of image — do not delete.

---

## 8. Phased plan (next)

| Phase | Goal | Gate |
|-------|------|------|
| **0** | Inspect + checkpoint (this doc) | DONE |
| **1** | Optional WebKit **worker** (metadata/extract only) behind feature flag | Only if Debian image builds and health stays green |
| **2** | Bridge research: interactive without VNC/CDP | STOP if no viable protocol |
| **3** | UI: engine status banner + EXTERNAL ↗ UX | No engine claim inflation |
| **4** | Website matrix + SoloHost smoke | Mark NOT TESTED where unproven |

**Rule:** Do not replace proxy as primary interactive path until a verified interactive bridge exists.

---

## 9. Acceptance tests (for later implementation)

### A. Must keep green (regression)

- [ ] `node test.js` PASS  
- [ ] `GET /api/health` → 200  
- [ ] `GET /api/engine/status` → `webkitGtkDisplay: false` unless bridge proven  
- [ ] History / bookmarks CRUD  
- [ ] AI chat localReply without key  
- [ ] Feedback routes mount  
- [ ] SSRF: `url=http://127.0.0.1` rejected on proxy  

### B. Engine worker (if built)

- [ ] Worker starts and stops with Node  
- [ ] Navigate returns title/url without hanging Node  
- [ ] Crash recovery does not orphan processes  
- [ ] No framebuffer/VNC ports exposed  

### C. SoloHost

- [ ] Image builds on GHCR/Actions  
- [ ] Smoke reaches health on assigned port  
- [ ] **Mark NOT TESTED ON SOLOHOST** until real install verified  

### D. Sites (evidence-based only)

PASS / PARTIAL / FAIL / NOT TESTED for: Google, YouTube, Facebook, TikTok, VnExpress, Thanh Nien, media hosts.

---

## 10. Checkpoint summary

| Item | Status |
|------|--------|
| Repo architecture mapped | DONE |
| Baseline unit/syntax tests | PASS |
| Docker build in this sandbox | BLOCKED (no daemon) |
| SoloHost live | NOT TESTED |
| WebKitGTK installable on Debian image | Likely PARTIAL |
| WebKitGTK as interactive SoloHost viewport under constraints | **BLOCKED** |
| Large architecture change | **Not started** (per instruction) |

**Continue from:** this file `docs/V10_PHASE0_CHECKPOINT.md` + existing hybrid-proxy code.
