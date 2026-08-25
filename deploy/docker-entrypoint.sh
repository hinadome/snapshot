#!/usr/bin/env bash
# Ensure data dir is writable, then start Snapshot (UI + API).
set -euo pipefail

DATA_DIR="${SNAPSHOT_DATA_DIR:-/data}"
mkdir -p "${DATA_DIR}/jobs"

# Named volumes are often root-owned; Playwright image prefers pwuser.
if [[ "$(id -u)" -eq 0 ]]; then
  if id pwuser &>/dev/null; then
    chown -R pwuser:pwuser "${DATA_DIR}" || true
    exec gosu pwuser node apps/server/dist/index.js
  fi
fi

exec node apps/server/dist/index.js
