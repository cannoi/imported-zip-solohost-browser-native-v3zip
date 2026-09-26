#!/bin/sh
set -eu
mkdir -p /app/data/chromium-profile /tmp/solohost-browser || true
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data /tmp/solohost-browser 2>/dev/null || true
  export HOME=/tmp/solohost-browser
  export SOLOHOST_BROWSER_DATA=/app/data/chromium-profile
  exec su -s /bin/sh node -c "cd /app && exec node server.js"
fi
exec node /app/server.js
