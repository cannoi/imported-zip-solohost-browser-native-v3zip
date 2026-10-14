FROM mcr.microsoft.com/playwright:v1.51.1-jammy

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    HOME=/tmp/solohost-browser \
    SOLOHOST_PLAYWRIGHT=1 \
    SOLOHOST_WEBKIT=0 \
    SOLOHOST_WEBKIT_BRIDGE=0 \
    SOLOHOST_DATA_DIR=/app/data \
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
    && chmod -R a+rwX /app/data /tmp/solohost-browser

# Run as root for SoloHost smoke reliability (no pwuser permission surprises)
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=4s --start-period=15s --retries=10 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200&&d.includes('ok')?0:1))}).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
