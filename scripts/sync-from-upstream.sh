#!/bin/bash
# Sync ai-bridge from the upstream jetbrains-cc-gui copy, preserving the two
# files we modified for stdio _ctrl IPC.
#
# Usage:
#   ./scripts/sync-from-upstream.sh           # diff-only, no overwrite
#   ./scripts/sync-from-upstream.sh --apply   # actually copy non-protected files

set -e
cd "$(dirname "$0")/.."

UPSTREAM=../jetbrains-cc-gui/ai-bridge
LOCAL=./ai-bridge
APPLY=0

if [[ "$1" == "--apply" ]]; then
  APPLY=1
fi

if [[ ! -d "$UPSTREAM" ]]; then
  echo "ERROR: upstream not found at $UPSTREAM"
  exit 1
fi

# Files we have modified locally — never overwrite, only diff.
PROTECTED=("daemon.js" "permission-ipc.js")

is_protected() {
  local base="$1"
  for p in "${PROTECTED[@]}"; do
    [[ "$p" == "$base" ]] && return 0
  done
  return 1
}

cd "$UPSTREAM"
FILES=$(find . -type f \
  -not -path './node_modules/*' \
  -not -name 'package-lock.json' \
  -not -name 'package.json')
cd - > /dev/null

for rel in $FILES; do
  base=$(basename "$rel")
  src="$UPSTREAM/$rel"
  dst="$LOCAL/$rel"

  if is_protected "$base"; then
    if ! diff -q "$src" "$dst" > /dev/null 2>&1; then
      echo "[PROTECTED-DIFF] $rel"
      diff -u "$dst" "$src" || true
      echo
    fi
    continue
  fi

  if [[ ! -f "$dst" ]]; then
    if (( APPLY )); then
      mkdir -p "$(dirname "$dst")"
      cp -v "$src" "$dst"
    else
      echo "[NEW]    $rel  (use --apply to copy)"
    fi
    continue
  fi

  if ! diff -q "$src" "$dst" > /dev/null 2>&1; then
    if (( APPLY )); then
      cp -v "$src" "$dst"
    else
      echo "[CHANGED] $rel  (use --apply to overwrite)"
    fi
  fi
done

echo
if (( APPLY )); then
  echo "Sync complete. Review changes with: git diff ai-bridge/"
else
  echo "Dry-run complete. Re-run with --apply to copy non-protected files."
fi
