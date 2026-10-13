# SoloHost Browser v10.25.7 — noVNC enabled (no VNC password), UI on 8080
FROM mcr.microsoft.com/playwright:v1.51.1-jammy

WORKDIR /app

# Install desktop stack for interactive Chromium (login / CAPTCHA)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      -o Acquire::http::Timeout=30 \
      -o Acquire::Retries=3 \
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
    DISPLAY=:99 \
    SOLOHOST_BROWSER_HEADFUL=1

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org/ \
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
 && node -e "require('./lib/app-adapter'); console.log('adapter-ok')"

# Only 8080 is the SoloHost primary URL; noVNC is proxied at /novnc on the same port
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=30s --retries=12 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200&&d.indexOf('ok')>=0?0:1))}).on('error',()=>process.exit(1))"

CMD ["./start.sh"]
