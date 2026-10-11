#!/bin/sh
set -e
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
export SOLOHOST_PLAYWRIGHT="${SOLOHOST_PLAYWRIGHT:-1}"
export SOLOHOST_WEBKIT="${SOLOHOST_WEBKIT:-0}"
export SOLOHOST_WEBKIT_BRIDGE="${SOLOHOST_WEBKIT_BRIDGE:-0}"
export HOME="${HOME:-/tmp/solohost-browser}"
export SOLOHOST_DATA_DIR="${SOLOHOST_DATA_DIR:-/app/data}"
mkdir -p "$HOME" "$SOLOHOST_DATA_DIR/pw-profiles" 2>/dev/null || true
exec node server.js
