#!/bin/sh
set -e
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
export SOLOHOST_WEBKIT="${SOLOHOST_WEBKIT:-1}"
export SOLOHOST_WEBKIT_DISPLAY="${SOLOHOST_WEBKIT_DISPLAY:-:99}"

# Private Xvfb for WebKit worker (no VNC port, no remote desktop)
if [ "${SOLOHOST_WEBKIT}" != "0" ] && [ -z "${DISPLAY}" ] && command -v Xvfb >/dev/null 2>&1; then
  Xvfb "${SOLOHOST_WEBKIT_DISPLAY}" -screen 0 1280x720x24 -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
  export DISPLAY="${SOLOHOST_WEBKIT_DISPLAY}"
  sleep 0.5
fi

exec node server.js
