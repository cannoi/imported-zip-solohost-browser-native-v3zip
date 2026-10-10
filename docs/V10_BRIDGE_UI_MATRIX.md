# Bridge UI integration — compatibility matrix

Environment: static tests + bridge unit tests. **NOT TESTED ON SOLOHOST** live UI.

## Modes

| Mode | When |
|------|------|
| ENGINE | Default for general sites; DOM bridge session per tab |
| PROXY | Fallback if engine/session fails |
| DIRECT | YouTube embed URLs |
| EXTERNAL | Facebook/Instagram/Netflix-class policy — user taps ↗ |

## Feature tests

| Feature | Status | Notes |
|---------|--------|-------|
| Address bar / Go | PASS (code) | Uses classify + bridge/proxy |
| Back / Forward | PASS (code) | Per-tab stack |
| Home / Reload | PASS (code) | Reload force navigate |
| Tabs isolation | PASS (code) | Bridge session on tab.nav |
| History / bookmarks | PASS (code) | Existing APIs |
| target=_blank policy | PARTIAL | Ctrl/meta/click → newTab in bridge view |
| Google Search | PARTIAL | No gbv/DDG force; engine→proxy; SPA limits |
| News (thanhnien…) | PARTIAL | Engine then proxy; needs live verify |
| SPA (YouTube home) | PARTIAL | ENGINE try; may PROXY; video often EXTERNAL |
| Facebook | EXTERNAL policy | Intentional |
| Login/cookies | PARTIAL | WebKit session when available; proxy limited |
| Proxy fallback hint | PASS (code) | showProxyHint with reason |
| External no auto-open | PASS (code) | Only ↗ |
| AI / Feedback / Logs | PASS | Unchanged modules |
| History after restart | PASS (code) | /app/data volume |

## Website matrix (evidence level)

| Site | Status | Evidence |
|------|--------|----------|
| example.com | PASS | test-bridge navigate |
| Google Search | PARTIAL | Code path only; interstitial known |
| YouTube | PARTIAL | embed DIRECT; home ENGINE/PROXY |
| Facebook | EXTERNAL | Policy classify |
| Thanh Nien | PARTIAL | Prior proxy.ok logs; live bridge NOT TESTED |
| Wikipedia | PARTIAL | Code classify ENGINE |
| TikTok / VieON | PARTIAL/EXTERNAL | DRM/SPA limits |

Do **not** claim Chrome parity.
