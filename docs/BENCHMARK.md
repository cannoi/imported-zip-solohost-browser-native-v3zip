# Benchmark

All rows NOT_MEASURED in the packager environment (no Docker daemon / no Xvfb+Chromium runtime here).

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
