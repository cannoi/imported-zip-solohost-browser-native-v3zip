# Benchmark

All rows NOT_MEASURED in the packager environment (no Docker daemon / no Xvfb+WebKit runtime here).

Do not treat this file as proof of speed.

| Metric | V5 CDP canvas | V6 noVNC | V6.1 kiosk | Notes |
|---|---|---|---|---|
| Docker image size | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED | |
| Cold startup | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED | |
| First page load | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED | |
| Idle RAM | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED | |
| RAM 1 tab | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED | |
| RAM 5 tabs | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED | |
| CPU idle / browse / video | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED | |
| Input latency / FPS | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED | |
| YouTube / WebGL / Canvas | NOT_MEASURED | NOT_MEASURED | NOT_MEASURED | |

On SoloHost run: docker compose up --build
Then record the row values before calling the app fast or production-ready.

## 7.2 measurement plan

The implementation now exposes enough state to benchmark startup, tab count, navigation timeout/recovery and profile size. Actual RAM/CPU/FPS/image-size numbers still require a real Docker + WebKitGTK runtime and must be measured on SoloHost hardware before publishing performance claims.


## 7.3 media validation status

GStreamer decoder presence is checked during Docker image build. End-to-end playback, YouTube adaptive-stream variants, audio reaching the host client, fullscreen behavior across sites, subtitle track availability, and DRM/Widevine remain NOT_MEASURED until tested in the actual SoloHost container. The current noVNC transport does not carry audio.

## v7.6.0 repeatable telemetry

The runtime now exposes `GET /api/performance` (alias `/api/diagnostics/performance`). It reports Node RSS/heap, CPU usage over the interval since the previous sample, cgroup memory, tab count, display resolution, and RSS for tracked engine/display process trees when available. `node scripts/benchmark.js http://127.0.0.1:8080 30` samples `/health`, `/ready`, `/api/browser/status`, and `/api/performance`, then reports p50/p95/min/max latency.

**This is not a full browser performance benchmark.** It does not yet measure page navigation-to-paint, FPS, input latency, decoded image memory, media rebuffering, network connection reuse to origins, noVNC bytes/sec, or CPU split among Xvfb/x11vnc/WebKit subprocesses. Collect comparable before/after reports on the same SoloHost hardware and same workload before claiming improvement.

| Metric | V7.5 | V7.6 | Status |
|---|---|---|---|
| API p50/p95 latency | NOT_MEASURED | Run benchmark script | Instrumentation added; runtime measurement required |
| Node RSS/heap | Not surfaced by dedicated endpoint | `/api/performance` | Available at runtime |
| cgroup memory pressure | NOT_MEASURED | `/api/performance` | Available if cgroup v2 files exist |
| Browser/display process-tree RSS | NOT_MEASURED | `/api/performance` | Best-effort `/proc`; detached/re-parented processes may be omitted |
| WebKit page render/FPS/input | NOT_MEASURED | NOT_MEASURED | Needs browser automation/real display capture |
| noVNC bandwidth and transport CPU | NOT_MEASURED | NOT_MEASURED | Needs network-byte and per-process CPU sampling on SoloHost |
