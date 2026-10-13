# SoloHost Browser — build-optimized for GitHub Actions
# Base already includes Chromium + Node; skip re-downloading browsers.
FROM mcr.microsoft.com/playwright:v1.51.1-jammy

WORKDIR /app

# One apt layer; no recommends; clean lists immediately
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb x11vnc openbox novnc websockify \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    HOME=/tmp/solohost-browser \
    SOLOHOST_PLAYWRIGHT=1 \
    SOLOHOST_WEBKIT=0 \
    SOLOHOST_WEBKIT_BRIDGE=0 \
    SOLOHOST_DATA_DIR=/app/data \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    DISPLAY=:99 \
    SOLOHOST_BROWSER_HEADFUL=1

# Dependency layer — cached unless package.json changes
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --prefer-offline \
 && npm cache clean --force \
 && rm -rf /tmp/* /root/.npm/_logs

# App source only (see .dockerignore)
COPY server.js server-app.js start.sh ./
COPY lib ./lib
COPY public ./public
COPY config_options.yml ./
# native kept small; WebKit disabled by default
COPY native ./native

RUN chmod +x start.sh \
 && mkdir -p /app/data/pw-profiles /tmp/solohost-browser \
 && chmod -R a+rwX /app/data /tmp/solohost-browser

EXPOSE 8080 6080

HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=8 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200&&d.includes('ok')?0:1))}).on('error',()=>process.exit(1))"

CMD ["./start.sh"]
