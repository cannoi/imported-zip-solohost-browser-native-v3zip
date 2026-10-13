# SoloHost Browser v10.25.9 — Bridge primary; noVNC optional (login only)
FROM mcr.microsoft.com/playwright:v1.51.1-jammy

WORKDIR /app

# Default: try install desktop packages with HARD 3-minute cap (never hang GHA for hours).
# Set WITH_NOVNC=0 to skip apt entirely on slow runners.
ARG WITH_NOVNC=1
RUN if [ "$WITH_NOVNC" = "1" ]; then \
      echo "noVNC packages (timeout 180s, login-only feature)..." \
      && (timeout 180 apt-get update \
          && timeout 180 apt-get install -y --no-install-recommends \
               -o Acquire::http::Timeout=15 \
               -o Acquire::https::Timeout=15 \
               -o Acquire::Retries=1 \
               xvfb x11vnc openbox novnc websockify \
          && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*) \
      || echo "WARN: noVNC apt skipped/failed — Bridge browsing still works"; \
    else \
      echo "WITH_NOVNC=0: skip apt"; \
    fi

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    HOME=/tmp/solohost-browser \
    SOLOHOST_PLAYWRIGHT=1 \
    SOLOHOST_WEBKIT=0 \
    SOLOHOST_WEBKIT_BRIDGE=0 \
    SOLOHOST_DATA_DIR=/app/data \
    SOLOHOST_NOVNC_ENABLED=1 \
    SOLOHOST_NOVNC_PORT=6080 \
    NOVNC_VNC_PASSWORD= \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_registry=https://registry.npmjs.org/ \
    DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
    DISPLAY=:99 \
    SOLOHOST_BROWSER_HEADFUL=0

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org/ --fetch-timeout=120000 --fetch-retries=2 \
 && node -e "require('express'); require('cors'); require('dotenv'); console.log('deps-ok')" \
 && npm cache clean --force \
 && rm -rf /tmp/* /root/.npm/_logs 2>/dev/null || true

COPY server.js server-app.js start.sh ./
COPY lib ./lib
COPY public ./public
COPY config_options.yml ./
COPY native ./native

RUN chmod +x start.sh \
 && mkdir -p /app/data/pw-profiles /tmp/solohost-browser \
 && chmod -R a+rwX /app/data /tmp/solohost-browser \
 && node -e "require('./lib/app-adapter'); require('./lib/novnc-launcher'); console.log('adapter-ok')"

EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=10 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200&&d.indexOf('ok')>=0?0:1))}).on('error',()=>process.exit(1))"

CMD ["./start.sh"]
