# AI Compatibility Assist (optional)

## Flow

```
User loads page via Bridge/Proxy (always works without AI)
        │
        ├── success → no AI call
        └── problem → optional "Ask AI" on hint banner
                │
                ▼
        POST /api/browser/ai-compat
          • redacts secrets
          • structure snippet only (≤2.5KB) + text ≤4KB
          • local heuristic if no provider / timeout / bad JSON
          • provider chat via existing AI module settings
                │
                ▼
        Validated JSON → show summary + suggestions
        (never auto-changes URL or executes shell)
```

## Data contract (response)

```json
{
  "ok": true,
  "summary": "string",
  "category": "ok|frame_blocked|spa_js|login_wall|captcha|media_drm|empty_content|network|unknown",
  "suggestions": ["string"],
  "recommendedMode": "ENGINE|PROXY|DIRECT|EXTERNAL|UNCHANGED",
  "confidence": 0.0,
  "source": "local_heuristic|provider|local_after_error|…"
}
```

## Security limits

- No cookies/passwords/tokens in request processing
- Redaction before provider
- No AI actions that change address bar or system
- Cache 20 min, max 40 entries
- Timeout default 20s
- Browsing path independent of AI

## Cost

- Zero when unused (opt-in button / explicit API)
- One small chat completion when user taps Ask AI and provider configured
