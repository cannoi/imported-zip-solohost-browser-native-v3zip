FROM node:22-trixie-slim AS build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    build-essential \
    g++ \
    pkg-config \
    cmake \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN cmake -S /app/native/webkit-engine -B /tmp/solohost-webkit-build \
    && cmake --build /tmp/solohost-webkit-build --config Release -j2 \
    && install -m 0755 /tmp/solohost-webkit-build/solohost-webkit-engine /tmp/solohost-webkit-engine

FROM node:22-trixie-slim
ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp/solohost-browser \
    SOLOHOST_BROWSER_DATA=/app/data/webkit-profile \
    SOLOHOST_ENGINE=webkit \
    SOLOHOST_ENGINE_CONTROL_PORT=9333 \
    DISPLAY=:99
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-0 \
    libgtk-3-0 \
    gstreamer1.0-libav \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    fonts-liberation \
    fonts-noto-core \
    ca-certificates \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    bubblewrap \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /tmp/solohost-webkit-engine /usr/local/bin/solohost-webkit-engine
COPY package.json package-lock.json ./
COPY server.js browser-gateway.js start.sh config_options.yml ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /app/data/webkit-profile /tmp/solohost-browser \
    && chmod +x /app/start.sh \
    && chown -R node:node /app/data /tmp/solohost-browser
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=4s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/start.sh"]
