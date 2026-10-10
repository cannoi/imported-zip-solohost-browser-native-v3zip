# SoloHost Browser 9.0.20 — Web compatibility patch report

## Root causes addressed
1. Streaming/music hosts were intentionally replaced by a placeholder shell before fetching their real page.
2. Responsive `srcset` images were sent through the HTML proxy, causing unnecessary `/api/proxy` requests and redirect logs.
3. DuckDuckGo `uddg` values were decoded twice even though `URLSearchParams.get()` already decodes once.
4. Google URL normalization forced legacy `gbv=1` and removed query parameters.
5. The Google interstitial continuation branch reassigned a `const` variable, so it could not adopt the continuation response.
6. The proxy cached some challenge/error HTML, allowing transient failures to persist for the short cache window.

## Changes
- Streaming/music sites now attempt to load their real HTML instead of a fake placeholder.
- `srcset` variants are absolute source-origin URLs.
- Google parameters are preserved; legacy HTML mode is opt-in (`SOLOHOST_GOOGLE_HTML_MODE=1`).
- DuckDuckGo redirect URLs are decoded once.
- Google continuation uses a reassignable response variable.
- Added direct-origin routing for additional common media and image file types.
- Skip caching blocked/challenge/error HTML.
- Added regression tests for these cases.

## Preserved
The existing application shell, tab UI, AI and feedback modules, history/bookmarks, settings/logging routes, existing SSRF/private-host checks, SoloHost Docker/package structure, and all original files are retained. Only `lib/frame-proxy.js`, `test.js`, `package.json`, and `CHANGELOG.md` are modified; this report is added.

## Validation
The automated source test suite and JavaScript syntax checks should be run with `npm test`. This environment does not prove full website compatibility, DRM support, or video playback on the actual SoloHost runtime. The HTML proxy remains limited by iframe/CORS/site anti-bot policies.
