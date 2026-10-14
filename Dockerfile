# SoloHost Browser — presentation baseline v10.20.2 + optional noVNC (login only)
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

ARG WITH_NOVNC=1
RUN if [ "$WITH_NOVNC" = "1" ]; then \
      echo "noVNC packages (timeout 180s, login-only)..." \
      && (timeout 180 apt-get update \
          && timeout 180 apt-get install -y --no-install-recommends \
               -o Acquire::http::Timeout=15 \
               -o Acquire::https::Timeout=15 \
               -o Acquire::Retries=1 \
               xvfb x11vnc openbox novnc websockify \
          && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*) \
      || echo "WARN: noVNC apt skipped — Bridge browsing still works"; \
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
    DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js server-app.js start.sh ./
COPY lib ./lib
COPY public ./public
COPY native ./native
COPY config_options.yml ./
COPY docs ./docs

RUN chmod +x start.sh \
    && mkdir -p /app/data /app/data/pw-profiles /tmp/solohost-browser \
    && chmod -R a+rwX /app/data /tmp/solohost-browser \
    && node -e "require('./lib/app-adapter'); try{require('./lib/novnc-launcher')}catch(e){}; console.log('ok')"

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=4s --start-period=15s --retries=10 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200&&d.includes('ok')?0:1))}).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
