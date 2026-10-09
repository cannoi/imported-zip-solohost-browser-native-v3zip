FROM node:22-trixie-slim AS build
ENV DEBIAN_FRONTEND=noninteractive \
    CC=gcc \
    CXX=g++
# build-essential provides make + g++/gcc (CMAKE_MAKE_PROGRAM / CMAKE_CXX_COMPILER)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    make \
    g++ \
    gcc \
    pkg-config \
    cmake \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && command -v make && command -v g++ && command -v cmake
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
RUN cmake -S /app/native/webkit-engine -B /tmp/solohost-webkit-build -G "Unix Makefiles" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_CXX_COMPILER=g++ \
        -DCMAKE_C_COMPILER=gcc \
        -DCMAKE_MAKE_PROGRAM="$(command -v make)" \
    && cmake --build /tmp/solohost-webkit-build --config Release -j2 \
    && install -m 0755 /tmp/solohost-webkit-build/solohost-webkit-engine /tmp/solohost-webkit-engine \
    && test -x /tmp/solohost-webkit-engine

FROM node:22-trixie-slim
ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp/solohost-browser \
    SOLOHOST_BROWSER_DATA=/app/data/webkit-profile \
    SOLOHOST_ENGINE=webkit \
    SOLOHOST_ENGINE_CONTROL_PORT=9333 \
    SOLOHOST_SECURITY_SETTINGS=/app/data/webkit-profile/security-settings.json \
    DISPLAY=:99
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-0 \
    libgtk-3-0 \
    gstreamer1.0-tools \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-plugins-ugly \
    gstreamer1.0-libav \
    gstreamer1.0-gl \
    fonts-liberation \
    fonts-noto-core \
    ca-certificates \
    xvfb \
    x11vnc \
    novnc \
    websockify \
    bubblewrap \
    && for plugin in playbin decodebin avdec_h264 avdec_aac avdec_mp3 vp8dec vp9dec vorbisdec opusdec; do gst-inspect-1.0 "$plugin" >/dev/null || { echo "Missing GStreamer media element: $plugin"; exit 1; }; done \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /tmp/solohost-webkit-engine /usr/local/bin/solohost-webkit-engine
COPY package.json package-lock.json ./
COPY server.js browser-gateway.js start.sh config_options.yml ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /app/data/webkit-profile /app/data /tmp/solohost-browser \
    && chmod +x /app/start.sh \
    && chown -R node:node /app/data /tmp/solohost-browser
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=4s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/start.sh"]
