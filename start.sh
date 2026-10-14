#!/bin/sh
# Primary: HTTP + Bridge (v10.20.2 presentation). noVNC starts only on demand (login/CAPTCHA).
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
export SOLOHOST_PLAYWRIGHT="${SOLOHOST_PLAYWRIGHT:-1}"
export SOLOHOST_WEBKIT="${SOLOHOST_WEBKIT:-0}"
export SOLOHOST_WEBKIT_BRIDGE="${SOLOHOST_WEBKIT_BRIDGE:-0}"
export HOME="${HOME:-/tmp/solohost-browser}"
export SOLOHOST_DATA_DIR="${SOLOHOST_DATA_DIR:-/app/data}"
export NODE_ENV="${NODE_ENV:-production}"
export SOLOHOST_BROWSER_HEADFUL="${SOLOHOST_BROWSER_HEADFUL:-0}"

mkdir -p "$HOME" "$SOLOHOST_DATA_DIR/pw-profiles" /tmp/solohost-browser 2>/dev/null || true
cd /app 2>/dev/null || cd "$(dirname "$0")" || true

echo "SoloHost Browser starting on ${HOST}:${PORT} (Bridge primary; noVNC on-demand for login)..."
exec node server.js
