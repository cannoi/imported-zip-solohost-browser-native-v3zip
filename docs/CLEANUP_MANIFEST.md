# CLEANUP MANIFEST v10.35.0

## Blocking fixes
- Removed `COPY native ./native` from Dockerfile (native/ deleted in 10.34)
- Removed SOLOHOST_WEBKIT* ENV from Dockerfile/start/compose

## Tier A deleted
| Item | Evidence | Bytes |
|---|---|---|
| public/made-by.png | no references | ~99 KB |
| lib/ai-agent.js | no runtime require | ~12 KB |
| lib/engine/content-router.js | inlined mustUseEngine into dom-bridge | ~3 KB |
| duplicate case press_key | second case unreachable | ~7 lines |
| webkit-manager | reduced to disabled stub | kept API |

## Tier B started
| Item | Status |
|---|---|
| lib/net-guard.js | NEW — assertPublicHttpUrl + isPrivateIp |
| lib/util.js | NEW — clip, sleep, escapeHtml |
| backend assertSafeUrl | delegates to net-guard |
| frame-proxy | re-exports net-guard |

## Not done (Tier C/D)
- Live mode delete vs complete
- Full frame-proxy shrink to 400 lines
- Merge agent-tools + research-tools
- TaskState single schema
- Test suite consolidation
- Image WebP compression

## v10.36.0 completion

### frame-proxy
- Rewritten lean proxy: **311 lines** (was 1221)
- Keeps: handleProxy, rewriteHtml, YouTube player shell, login external, asset redirect, net-guard SSRF
- Stubs kept for removed Google/DDG helpers used by old tests

### agent-web
- `lib/agent-web.js` unifies research-tools + agent-tools exports
- research-tools SSRF → net-guard

### Live mode
- **Removed** `lib/engine/live-stream.js`, `public/live-view.js`, index script tag, server require
- Reason: incomplete (no client init); reduces WS attack surface

### Planner + DAG
- `lib/agent-planner.js`: rules plan for compare_products / news / generic
- `TaskState` shape + `runDag` on agent-runner

### Icons
- ai-icon.png ~37KB → ~12KB; splash-logo.jpg ~21KB → ~11KB

### Tests
- `npm test` → `test-core.js` (~10 focused files)
- `npm run test:all` keeps historical chain

## v10.37.0

### agent-web single entry
- Implementations: `agent-tools-impl.js`, `agent-research-impl.js`
- Public API: `agent-web.js`
- Shims: `agent-tools.js`, `agent-research-tools.js` → re-export agent-web
- backend-agent uses only `agent-web`

### TaskState
- `ensureTaskState` / `syncTaskState` in backend-agent
- Called at `start` and `runTask`
- workMemory retained as compatibility view; taskState is canonical bag for plan/status/sources

### Planner
- `planWithLLM(ai, brief, lang)` — one LLM JSON plan when not compare/news/chat
- `start()` uses `agentPlanner.planFromRules` for initial plan/jobs

### Tests
- `npm test` = test-core.js
- `npm run test:all` = core + security + bridge + youtube + backend-agent + agent-v1026 + evidence

## v10.39.0
- Added: lib/adapters/youtube.js, lib/render-error.js, public/layout-guard.js
- frame-proxy YouTube special path restored via adapter
- Chromium lighter route + debounced persist
- Partial: full Tier A HTTP router and AI search deferred
