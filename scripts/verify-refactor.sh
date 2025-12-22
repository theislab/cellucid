#!/usr/bin/env bash
set -euo pipefail

APP_DIR="assets/js/app"
TRACKER_FILE="assets/js/analytics/tracker.js"

exit_code=0

echo "=== Cellucid Refactor Verification ==="
echo "App dir: $APP_DIR"

if [[ ! -d "$APP_DIR" ]]; then
  echo "ERROR: '$APP_DIR' not found (run from repo root)."
  exit 1
fi

echo ""
echo "== Megafile Removal =="
if [[ -f "$APP_DIR/state.js" ]]; then
  echo "FAIL: $APP_DIR/state.js still exists"
  exit_code=1
else
  echo "OK: state.js removed"
fi

if [[ -f "$APP_DIR/ui.js" ]]; then
  echo "FAIL: $APP_DIR/ui.js still exists"
  exit_code=1
else
  echo "OK: ui.js removed"
fi

echo ""
echo "== Largest Files (excluding analysis/) =="
find "$APP_DIR" -path "$APP_DIR/analysis" -prune -o -type f -name '*.js' -print0 \
  | xargs -0 wc -l \
  | sort -nr \
  | head -n 20

echo ""
echo "== Duplicate Utility Definitions =="
is_finite_defs=$(
  { grep -R --include='*.js' -E '^(export )?function isFiniteNumber\b' "$APP_DIR" || true; } \
    | wc -l \
    | tr -d ' '
)
if [[ "$is_finite_defs" -gt 1 ]]; then
  echo "FAIL: isFiniteNumber definitions: $is_finite_defs (expected: 1)"
  exit_code=1
else
  echo "OK: isFiniteNumber definitions: $is_finite_defs"
fi

echo ""
echo "== Console.log Audit (excluding analysis/) =="
console_logs=$(
  { grep -R --include='*.js' --exclude-dir='analysis' -F 'console.log' "$APP_DIR" || true; } \
    | wc -l \
    | tr -d ' '
)
echo "Found console.log statements: $console_logs"

echo ""
echo "== Inline Clamp Pattern Audit (excluding analysis/) =="
inline_clamps=$(
  { grep -R --include='*.js' --exclude-dir='analysis' --exclude='number-utils.js' -E 'Math\.max\([^)]*Math\.min' "$APP_DIR" || true; } \
    | wc -l \
    | tr -d ' '
)
echo "Found inline clamp patterns: $inline_clamps"

echo ""
echo "== Data Load Method Coverage =="
if [[ -f "$TRACKER_FILE" ]]; then
  methods=$(
    awk -F"'" '
      /export const DATA_LOAD_METHODS = {/{inblock=1; next}
      inblock && /^};/{inblock=0}
      inblock && NF >= 2 {print $2}
    ' "$TRACKER_FILE" | sort -u
  )

  if command -v rg >/dev/null 2>&1; then
    has_text() { rg -q --fixed-strings "$1" assets/js --glob '!analytics/tracker.js'; }
  else
    has_text() { grep -R -q --fixed-strings --exclude='tracker.js' "$1" assets/js; }
  fi

  missing=0
  while IFS= read -r method; do
    [[ -z "$method" ]] && continue
    if has_text "$method"; then
      echo "OK: $method"
    else
      echo "FAIL: $method (not referenced outside tracker.js)"
      missing=1
    fi
  done <<< "$methods"

  if [[ "$missing" -ne 0 ]]; then
    exit_code=1
  fi
else
  echo "WARN: $TRACKER_FILE not found; skipping method coverage."
fi

echo ""
if [[ "$exit_code" -eq 0 ]]; then
  echo "=== Verification Complete: OK ==="
else
  echo "=== Verification Complete: FAIL ==="
fi

exit "$exit_code"
