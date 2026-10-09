# SoloHost Browser 8 — Install

The container is based on `mcr.microsoft.com/playwright:v1.40.0-focal` (Node.js + the matching Chromium). No WebKitGTK, GStreamer, Xvfb or VNC packages are installed.

```bash
npm install            # first time only: creates package-lock.json — commit it
docker compose build
docker compose up -d
curl http://127.0.0.1:18080/ready          # {"status":"READY",...}
docker compose exec web node scripts/smoke-extract.js https://example.com
```

Expose port 8080 through SoloHost. Persistent data lives in `/app/data/webkit-profile` (legacy folder name kept on purpose).

**Version rule:** the image tag (`v1.40.0`) and the `playwright` / `playwright-core` versions in `package.json` must be identical; the Docker build fails early if Chromium is not found for that version.
