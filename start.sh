#!/bin/sh
# Fail-soft startup for SoloHost / GHCR smoke tests — must bind PORT quickly.
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
export SOLOHOST_PLAYWRIGHT="${SOLOHOST_PLAYWRIGHT:-1}"
export SOLOHOST_WEBKIT="${SOLOHOST_WEBKIT:-0}"
export SOLOHOST_WEBKIT_BRIDGE="${SOLOHOST_WEBKIT_BRIDGE:-0}"
export HOME="${HOME:-/tmp/solohost-browser}"
export SOLOHOST_DATA_DIR="${SOLOHOST_DATA_DIR:-/app/data}"
export NODE_ENV="${NODE_ENV:-production}"

mkdir -p "$HOME" "$SOLOHOST_DATA_DIR/pw-profiles" /tmp/solohost-browser 2>/dev/null || true

cd /app 2>/dev/null || cd "$(dirname "$0")" || true

echo "SoloHost Browser starting on ${HOST}:${PORT}..."
exec node server.js
