#!/bin/sh
# Bind HTTP first (SoloHost / GHCR smoke). Optional noVNC never blocks listen.
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

start_novnc() {
  [ "${SOLOHOST_NOVNC_ENABLED:-0}" = "1" ] || return 0
  command -v Xvfb >/dev/null 2>&1 || { echo "WARN: noVNC skipped (Xvfb not in image). Rebuild with --build-arg WITH_NOVNC=1"; return 0; }
  command -v x11vnc >/dev/null 2>&1 || { echo "WARN: noVNC skipped (x11vnc missing)"; return 0; }
  command -v websockify >/dev/null 2>&1 || { echo "WARN: noVNC skipped (websockify missing)"; return 0; }

  export DISPLAY="${DISPLAY:-:99}"
  # VNC password optional — empty = no rfbauth (local/docker network only)
  Xvfb "$DISPLAY" -screen 0 "${SOLOHOST_VNC_GEOMETRY:-1280x720x24}" -ac -nolisten tcp -noreset >/tmp/solohost-xvfb.log 2>&1 &
  sleep 0.5
  if command -v openbox >/dev/null 2>&1; then openbox >/tmp/solohost-openbox.log 2>&1 & fi
  if [ -n "${NOVNC_VNC_PASSWORD}" ] && [ "${#NOVNC_VNC_PASSWORD}" -ge 6 ]; then
    x11vnc -storepasswd "$NOVNC_VNC_PASSWORD" /tmp/solohost-vnc.pass >/dev/null 2>&1
    x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -localhost -rfbauth /tmp/solohost-vnc.pass -noxdamage >/tmp/solohost-x11vnc.log 2>&1 &
  else
    x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -localhost -nopw -noxdamage >/tmp/solohost-x11vnc.log 2>&1 &
  fi
  sleep 0.3
  websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 >/tmp/solohost-websockify.log 2>&1 &
  export SOLOHOST_BROWSER_HEADFUL=1
  echo "Interactive desktop (noVNC) on :6080"
}

# Background — never delay node listen
start_novnc &

echo "SoloHost Browser starting on ${HOST}:${PORT}..."
exec node server.js
