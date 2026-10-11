# Playwright image includes Chromium; HTTP server must listen immediately on PORT
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
    DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
# Install app deps only; browsers already in base image
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY server.js start.sh ./
COPY lib ./lib
COPY public ./public
COPY native ./native
COPY config_options.yml ./
COPY docs ./docs

RUN chmod +x start.sh \
    && mkdir -p /app/data /app/data/pw-profiles /tmp/solohost-browser \
    && (chown -R pwuser:pwuser /app /tmp/solohost-browser 2>/dev/null || true)

# Stay as root if pwuser missing; otherwise pwuser (Playwright default)
USER pwuser

EXPOSE 8080

# Fast health for SoloHost / Actions smoke (must respond in <90s)
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=8 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# Direct node is more reliable than shell for signal/smoke detection
CMD ["node", "server.js"]
