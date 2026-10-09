# SoloHost Browser v8 Phase 1 — headless Chromium (Playwright) + Readability.
# The base image already ships Node.js and the Chromium build that matches Playwright 1.40.0,
# so the old native toolchain, GUI/WebKit libraries, media stack and X11/VNC display packages are gone.
# KEEP the image tag and the "playwright"/"playwright-core" versions in package.json identical.
FROM mcr.microsoft.com/playwright:v1.40.0-focal

ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp/solohost-browser \
    SOLOHOST_BROWSER_DATA=/app/data/webkit-profile \
    SOLOHOST_ENGINE=chromium \
    SOLOHOST_SECURITY_SETTINGS=/app/data/webkit-profile/security-settings.json \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# package-lock.json is optional (glob): run `npm install` once locally and commit it for reproducible builds.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Fail the build early if a dependency is missing or the Chromium revision does not match Playwright.
RUN node -e "for (const m of ['playwright-core','playwright','jsdom','@mozilla/readability','lru-cache','express','ws']) require(m); \
const p = require('playwright-core').chromium.executablePath(); \
if (!require('fs').existsSync(p)) { console.error('Chromium not found at ' + p + ' - image tag and playwright version must match'); process.exit(1); } \
console.log('Chromium OK:', p)"

COPY server.js browser-gateway.js start.sh config_options.yml ./
COPY lib ./lib
COPY public ./public

# start.sh drops privileges to the "node" user; this image only ships "pwuser", so create it when missing.
RUN (id -u node >/dev/null 2>&1 || useradd --create-home --shell /bin/sh node) \
    && mkdir -p /app/data/webkit-profile /tmp/solohost-browser \
    && chmod +x /app/start.sh \
    && chown -R node:node /app/data /tmp/solohost-browser

EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=4s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/start.sh"]
