#!/bin/sh
set -e
export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
exec node server.js
