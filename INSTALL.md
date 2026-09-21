# Installation Guide

1. Install via SoloHost or `docker compose -f docker-compose.yml up -d`.
2. Set the host port in SoloHost settings.
3. Open `http://localhost:<HOST_PORT>`.
4. Registered SoloHost apps appear in the home constellation through `GET /api/apps`.


## Internet browsing gateway

The browser UI loads external HTTP/HTTPS pages through a same-origin gateway at `/api/proxy` (same host and port as the UI itself), so sites that send `X-Frame-Options` or CSP `frame-ancestors` can still be displayed inside the embedded viewport.

Only one host port needs to be mapped/forwarded — the one set in SoloHost settings. Earlier versions also started a second gateway on container port `8081` and required the client's browser to connect to it directly. That second port is only ever reachable on `127.0.0.1` of the host machine, so it never worked through SoloHost's normal domain/reverse-proxy access — pages would fail to load and the app would misreport it as "no Internet connection". This has been fixed: all proxying now happens on the single port that is actually exposed.
