FROM node:20-alpine
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    HOME=/tmp/solohost-browser \
    npm_config_update_notifier=false

# wget for HEALTHCHECK (alpine node image does not include it by default)
RUN apk add --no-cache wget

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js start.sh ./
RUN chmod +x start.sh
COPY lib ./lib
COPY public ./public
COPY config_options.yml ./

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["./start.sh"]
