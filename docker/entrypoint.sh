#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"

if [ "$(id -u)" = "0" ]; then
  # Mounted volumes are often root-owned: make DATA_DIR usable by the node user, then drop privileges.
  # A read-only or otherwise unfixable DATA_DIR is not fatal: the app warns and runs without local files.
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  if ! su-exec node sh -c 'test -w "$1"' _ "$DATA_DIR"; then
    echo "[entrypoint] fixing permissions on $DATA_DIR for the node user"
    chown -R node:node "$DATA_DIR" || echo "[entrypoint] warning: could not fix permissions on $DATA_DIR (read-only volume?); continuing without a writable data directory"
  fi
  export HOME=/home/node
  su-exec node node /app/dist/boot.mjs
  exec su-exec node node /app/server.js
fi

# Already started as a non-root user: run as is.
node /app/dist/boot.mjs
exec node /app/server.js
