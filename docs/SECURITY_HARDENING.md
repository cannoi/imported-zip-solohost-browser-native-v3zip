# Security hardening (V10.3.4)

## SSRF (Node proxy + bridge navigate)

- Scheme: http/https only
- Block credentials in URL
- Block localhost, `.local`, `.internal`, `.lan`, metadata hostnames
- Block private IPv4/IPv6 (incl. 169.254.169.254, CGNAT 100.64/10)
- DNS resolve **fail-closed**; every A/AAAA must be public
- Redirect hops re-validated (`fetchDocument` manual redirect)
- Sensitive ports blocked (22, 2375/2376 docker, 6443 k8s, 3306, …) except 80/443

## Sessions / bridge

- 48-byte hex token; `timingSafeEqual` auth
- Events allowlist: click|input|change|submit|scroll|navigate
- Rate limit; max sessions; HTML snapshot size cap
- View CSP: `script-src 'none'`

## Engine API

- Session control requires `SOLOHOST_WEBKIT_BRIDGE=1`
- Optional `SOLOHOST_ENGINE_TOKEN` header

## Container

- `USER node` (non-root)
- No docker.sock, no privileged in Dockerfile

## Media

See `MEDIA_PROBE.json` — **no Widevine claim**.
