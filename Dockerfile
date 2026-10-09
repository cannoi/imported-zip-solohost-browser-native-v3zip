FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/tmp/solohost-browser
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY config_options.yml docker-compose.yml ./
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "server.js"]
