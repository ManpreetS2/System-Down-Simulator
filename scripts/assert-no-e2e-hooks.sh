#!/usr/bin/env bash
# Fail if Vite test-mode e2e hook identifiers leak into a built JS bundle.
# Usage: scripts/assert-no-e2e-hooks.sh <dist-dir>
set -euo pipefail

DIST_DIR="${1:-dist}"
PATTERN='e2eQueue|e2eTimerSec|e2eStartHealth|mulberry32'

if [[ ! -d "$DIST_DIR" ]]; then
  echo "assert-no-e2e-hooks: missing directory $DIST_DIR" >&2
  exit 2
fi

shopt -s nullglob
files=("$DIST_DIR"/assets/*.js)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "assert-no-e2e-hooks: no JS assets under $DIST_DIR/assets" >&2
  exit 2
fi

if grep -REn "$PATTERN" "${files[@]}" >/tmp/e2e-hook-hits.txt 2>/dev/null; then
  echo "assert-no-e2e-hooks: FAIL — test hooks found in $DIST_DIR:" >&2
  cat /tmp/e2e-hook-hits.txt >&2
  exit 1
fi

echo "assert-no-e2e-hooks: ok — no e2e hook identifiers in $DIST_DIR"
