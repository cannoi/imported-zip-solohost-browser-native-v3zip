FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    HOME=/tmp/solohost-browser \
    SOLOHOST_WEBKIT=1 \
    SOLOHOST_WEBKIT_DISPLAY=:99 \
    XDG_CACHE_HOME=/tmp/solohost-browser/.cache \
    XDG_CONFIG_HOME=/tmp/solohost-browser/.config \
    XDG_RUNTIME_DIR=/tmp/solohost-browser/run \
    GSETTINGS_BACKEND=memory \
    npm_config_update_notifier=false \
    DEBIAN_FRONTEND=noninteractive

# WebKitGTK + Xvfb (virtual display for worker only — NOT VNC/noVNC streaming)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-gi \
    gir1.2-gtk-3.0 \
    gir1.2-webkit2-4.1 \
    libwebkit2gtk-4.1-0 \
    xvfb \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js start.sh ./
RUN chmod +x start.sh
COPY lib ./lib
COPY public ./public
COPY native ./native
COPY config_options.yml ./
COPY docs ./docs

RUN mkdir -p /app/data /tmp/solohost-browser/.cache /tmp/solohost-browser/.config /tmp/solohost-browser/.local/share /tmp/solohost-browser/run && chown -R node:node /app /tmp/solohost-browser

# Xvfb needs to start as same user; node user runs start.sh
USER node
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=25s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["./start.sh"]
