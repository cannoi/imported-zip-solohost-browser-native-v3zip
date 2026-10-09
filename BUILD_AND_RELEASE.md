# Build and release — SoloHost Browser 8

## Runtime architecture
Headless Chromium (Playwright) inside Docker. The Node shell asks `ContentExtractor` to open pages, collects `.m3u8`/`.mp4` network responses, and converts the rendered HTML to a clean article with jsdom + `@mozilla/readability`. There is no native C++ code and no display transport.

## Build
Single-stage Dockerfile on `mcr.microsoft.com/playwright:v1.40.0-focal`: `npm install --omit=dev`, then a build-time check that every dependency loads and that Chromium exists for the installed Playwright version.

## Validation checklist
1. `npm test` passes (static contracts, extractor orchestration, engine, reader view; real jsdom/Readability fixture runs once dependencies are installed).
2. `docker compose build` succeeds (this step runs the Chromium presence check).
3. `curl /ready` returns `READY`.
4. `docker compose exec web node scripts/smoke-extract.js <url>` for one English and one Vietnamese site.
5. Open the app, search a URL, confirm Reader view, media list, back/forward/reload, and the AI panel answering in the language you type.

## Security & privacy foundation (v7.5, still applies)
Persisted security settings and `/security` UI, dangerous-scheme/credential checks, private-network blocking, download policy. Page-level permission prompts, popups and in-page downloads belonged to the WebKit engine and are not applicable to the Phase 1 reader.

## Performance validation
`node scripts/benchmark.js http://127.0.0.1:8080 30` measures API latency only. Extraction time per page is reported in every result (`duration_ms`) and by the smoke script; no speed or memory improvement over v7.x has been measured yet.
