#!/bin/sh
set -e
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
export SOLOHOST_WEBKIT="${SOLOHOST_WEBKIT:-1}"
export SOLOHOST_WEBKIT_DISPLAY="${SOLOHOST_WEBKIT_DISPLAY:-:99}"

# Writable dirs for node user (Fontconfig / dconf / WebKit cache) — never /root
export HOME="${HOME:-/tmp/solohost-browser}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-$HOME/run}"
export FONTCONFIG_PATH="${FONTCONFIG_PATH:-/etc/fonts}"
# Reduce dconf noise in containers without session bus
export GSETTINGS_BACKEND="${GSETTINGS_BACKEND:-memory}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-disabled:}"

mkdir -p "$HOME" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" \
  /app/data 2>/dev/null || true
chmod -R u+rwX "$HOME" 2>/dev/null || true

# Private Xvfb for WebKit worker only (NOT VNC streaming)
if [ "${SOLOHOST_WEBKIT}" != "0" ] && [ -z "${DISPLAY}" ] && command -v Xvfb >/dev/null 2>&1; then
  Xvfb "${SOLOHOST_WEBKIT_DISPLAY}" -screen 0 1280x720x24 -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &
  export DISPLAY="${SOLOHOST_WEBKIT_DISPLAY}"
  sleep 0.4
fi

exec node server.js
