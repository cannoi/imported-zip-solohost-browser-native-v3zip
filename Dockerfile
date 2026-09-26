FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp/solohost-browser \
    SOLOHOST_BROWSER_DATA=/app/data/chromium-profile \
    CHROME_PATH=/usr/bin/chromium \
    DISPLAY=:99
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    fonts-noto-core \
    ca-certificates \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data/chromium-profile /tmp/solohost-browser \
    && chmod +x /app/start.sh \
    && chown -R node:node /app /tmp/solohost-browser || true
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=4s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/start.sh"]
