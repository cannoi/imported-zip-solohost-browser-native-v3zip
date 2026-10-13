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

# Optional interactive Chromium desktop. noVNC is disabled unless explicitly enabled
# and a VNC password is configured; this prevents accidental unauthenticated exposure.
if [ "${SOLOHOST_NOVNC_ENABLED:-0}" = "1" ]; then
  if [ "${#NOVNC_VNC_PASSWORD}" -lt 8 ]; then
    echo "WARN: noVNC disabled: set NOVNC_VNC_PASSWORD to at least 8 characters (VNC protocol uses the first 8)."
    export SOLOHOST_NOVNC_ENABLED=0
  else
    export DISPLAY="${DISPLAY:-:99}"
    Xvfb "$DISPLAY" -screen 0 "${SOLOHOST_VNC_GEOMETRY:-1440x900x24}" -ac +extension GLX +render -noreset >/tmp/solohost-xvfb.log 2>&1 &
    sleep 1
    openbox >/tmp/solohost-openbox.log 2>&1 &
    x11vnc -storepasswd "$NOVNC_VNC_PASSWORD" /tmp/solohost-vnc.pass >/dev/null 2>&1
    chmod 600 /tmp/solohost-vnc.pass
    x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -localhost -rfbauth /tmp/solohost-vnc.pass -noxdamage >/tmp/solohost-x11vnc.log 2>&1 &
    sleep 1
    websockify --web=/usr/share/novnc 0.0.0.0:6080 localhost:5900 >/tmp/solohost-websockify.log 2>&1 &
    echo "Interactive desktop enabled on port 6080; VNC password is required."
  fi
fi

# Chromium must launch headed under Xvfb for the noVNC display to show the same Playwright pages.
if [ "${SOLOHOST_NOVNC_ENABLED:-0}" != "1" ]; then export SOLOHOST_BROWSER_HEADFUL=0; fi

echo "SoloHost Browser starting on ${HOST}:${PORT}..."
exec node server.js
