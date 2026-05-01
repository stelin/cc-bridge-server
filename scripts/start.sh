#!/bin/bash
# Production start script.
set -e
cd "$(dirname "$0")/.."

export PORT="${PORT:-3284}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export SESSION_IDLE_TIMEOUT_MS="${SESSION_IDLE_TIMEOUT_MS:-60000}"

exec node src/server.js
