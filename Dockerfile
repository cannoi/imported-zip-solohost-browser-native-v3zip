# Playwright ships Chromium + system deps for full JS/CSS/cookies engine
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    HOME=/tmp/solohost-browser \
    SOLOHOST_PLAYWRIGHT=1 \
    SOLOHOST_WEBKIT=0 \
    SOLOHOST_WEBKIT_BRIDGE=0 \
    SOLOHOST_PW_MAX_SESSIONS=4 \
    SOLOHOST_PW_NAV_TIMEOUT_MS=25000 \
    SOLOHOST_DATA_DIR=/app/data \
    npm_config_update_notifier=false \
    DEBIAN_FRONTEND=noninteractive

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm install playwright@1.49.1 --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY server.js start.sh ./
RUN chmod +x start.sh
COPY lib ./lib
COPY public ./public
COPY native ./native
COPY config_options.yml ./
COPY docs ./docs

RUN mkdir -p /app/data /app/data/pw-profiles /tmp/solohost-browser \
    && chown -R pwuser:pwuser /app /tmp/solohost-browser || chown -R node:node /app /tmp/solohost-browser || true

# playwright image uses pwuser
USER pwuser
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["./start.sh"]
