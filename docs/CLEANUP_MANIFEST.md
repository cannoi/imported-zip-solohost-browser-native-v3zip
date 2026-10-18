# CLEANUP MANIFEST — SoloHost Browser v10.45.0

## Removed
| Path | Reason | Evidence |
|---|---|---|
| lib/ai-compat.js + route + test | Log-only LLM finding | No browse behavior |
| lib/agent-tools.js, agent-research-tools.js | 2-line facades | require → agent-web |
| lib/agent-tools-impl.js, agent-research-impl.js | Merged into agent-web.js | Single module body |
| public helpers modeLabel / isLocalSoloHostUrl / navigateProxyFallback | Never called | grep |
| frame-proxy trackRepeat / detectBlockedPage | Dead | grep |
| playwright withPage / __getSessionPage | Export-only | grep |
| docs/V10.*.REPORT (19 files) | Historical; kept V10.45.0 + ARCHITECTURE + MANIFEST | |

## Replaced / slimmed
| Change | Notes |
|---|---|
| lib/agent-web.js | Full tools+research body |
| lib/agent-actions.js | executeAction extracted (~470 lines out of backend-agent) |
| lib/challenge.js | Shared blocked-page detector |
| lib/config.js | ≤20 documented env knobs |
| geoip | Opt-in SOLOHOST_GEO_LOOKUP=1 |
| idle_sweep | Log only when closed>0 |
| agent-report.groundSummary | Less false ⚠; strip HTML leakage |
| server-app engine routes | deprecateRoute middleware (log+count) |
| npm test | Core suite in test/ |

## Deferred
- Split navigateInternal / dispatchEvent / runTask further
- Collapse remaining 57 root test-*.js files (still on disk; not in default npm test)
- Tier C lazy-load of public/app.js + routes/* split
- Full agent appendix §6 (multi-source parallel search quality) beyond report grounding

## NOT TESTED ON SOLOHOST
Docker image build, live Chromium, real Google login, network AI keys.

## 10.45.1 additions
- test/archive/: 29 source-style tests
- app-adapter buildKnowledge ~700 chars
- agent-retail-parallel.js
- isBingVerification → challenge.js
- browser-agent evidence-before-deny rule
