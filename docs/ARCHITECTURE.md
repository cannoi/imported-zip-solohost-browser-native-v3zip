# SoloHost Browser — Architecture

```
User UI (public/app.js)
  → Express (server.js → server-app.js)
    → Bridge sessions (/api/browser/sessions*)
        → Playwright Chromium (lib/engine/playwright-engine.js)
        → DOM Bridge snapshot (lib/engine/dom-bridge.js)
    → Proxy fallback (lib/frame-proxy.js) for selected hosts (e.g. YouTube)
    → AI Panel + Browser Agent (lib/ai-module/*, lib/backend-agent.js)
    → optional noVNC (login assist only)
```

Engines in production path: **Chromium (Playwright)** + **HTTP proxy**.  
SSRF: `lib/net-guard.js`. Agent tools: `lib/agent-web.js`.
