#!/bin/bash
# Production start script.
set -e
cd "$(dirname "$0")/.."

export PORT="${PORT:-3284}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export SESSION_IDLE_TIMEOUT_MS="${SESSION_IDLE_TIMEOUT_MS:-60000}"

# Make globally installed npm packages (e.g. @anthropic-ai/claude-agent-sdk)
# resolvable by the daemon via Node's standard module resolver. `npm root -g`
# returns the global node_modules root; we also keep any pre-existing NODE_PATH.
if command -v npm >/dev/null 2>&1; then
  GLOBAL_NM="$(npm root -g 2>/dev/null || true)"
  if [ -n "$GLOBAL_NM" ]; then
    if [ -n "$NODE_PATH" ]; then
      export NODE_PATH="$NODE_PATH:$GLOBAL_NM"
    else
      export NODE_PATH="$GLOBAL_NM"
    fi
  fi
fi

exec node src/server.js
