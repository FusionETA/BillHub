#!/usr/bin/env bash
# Brings up a throwaway local stack for poking at the UI: a scratch MariaDB, the
# schema, an owner login, demo bills, and the server.
#
#   ./scripts/dev-local.sh          start (reuses the data if it is already there)
#   ./scripts/dev-local.sh --reset  wipe the databases and start fresh
#   ./scripts/dev-local.sh --stop   stop the server and the database
#
# This touches nothing on DigitalOcean and nothing belonging to WazzOCR — the
# `wazzocr_test` schema it creates is a fixture with fake tenant ids. Real Xero
# calls fail by design, because .env carries a placeholder client secret.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${BILLHUB_DEV_DATA:-$ROOT/.devdata}"
PORT=13306
SOCK=/tmp/billhub-dev.sock
MYSQLD="$(command -v mysqld || echo /opt/homebrew/bin/mysqld)"
MYSQL="$(command -v mysql || echo /opt/homebrew/bin/mysql)"
APP_PORT=3311

stop() {
  pkill -f "node $ROOT/server.js" 2>/dev/null || true
  pkill -f "node server.js" 2>/dev/null || true
  "$(dirname "$MYSQL")/mysqladmin" -h 127.0.0.1 -P "$PORT" -u root shutdown 2>/dev/null || true
  echo "Stopped."
}

case "${1:-}" in
  --stop) stop; exit 0 ;;
  --reset) stop; rm -rf "$DATA"; echo "Wiped $DATA." ;;
esac

if [ ! -x "$MYSQLD" ]; then
  echo "mysqld not found. Install MariaDB first:  brew install mariadb" >&2
  exit 1
fi

# Reuse whatever is already listening on the port rather than initialising a
# second data directory we would never use.
if "$MYSQL" -h 127.0.0.1 -P "$PORT" -u root -e "SELECT 1" >/dev/null 2>&1; then
  echo "Reusing the MariaDB already running on port $PORT."
else
  if [ ! -d "$DATA" ]; then
    echo "Initialising a scratch database in $DATA ..."
    mkdir -p "$DATA"
    "$(dirname "$MYSQLD")/mariadb-install-db" --datadir="$DATA" --auth-root-authentication-method=normal >/dev/null 2>&1
  fi
  echo "Starting MariaDB on port $PORT ..."
  "$MYSQLD" --datadir="$DATA" --socket="$SOCK" --port="$PORT" \
    --bind-address=127.0.0.1 --log-error="$DATA/mysqld.log" --pid-file="$DATA/mysqld.pid" >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    "$MYSQL" -h 127.0.0.1 -P "$PORT" -u root -e "SELECT 1" >/dev/null 2>&1 && break
    sleep 1
  done
  if ! "$MYSQL" -h 127.0.0.1 -P "$PORT" -u root -e "SELECT 1" >/dev/null 2>&1; then
    echo "MariaDB did not come up. See $DATA/mysqld.log" >&2
    exit 1
  fi
fi

"$MYSQL" -h 127.0.0.1 -P "$PORT" -u root -e \
  "CREATE DATABASE IF NOT EXISTS billhub_test CHARACTER SET utf8mb4" 2>/dev/null

if [ ! -f "$ROOT/.env" ]; then
  echo "Writing a local .env ..."
  cat > "$ROOT/.env" <<'ENV'
PORT=3311
NODE_ENV=development
PUBLIC_BASE_URL=http://localhost:3311
APP_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
DB_HOST=127.0.0.1
DB_PORT=13306
DB_USER=root
DB_PASSWORD=
DB_NAME=billhub_test
DB_SSL=disable

# No sign-in for local poking. Safe here: it only listens on localhost.
AUTH_DISABLED=true
DEFAULT_ACCOUNT_ID=1

WAZZOCR_DB_NAME=wazzocr_test
WAZZOCR_URL=https://wazzocr.example.com
# Placeholders: the local stack runs against stubbed Xero, so real Xero calls
# fail by design. Put the real values in .env yourself to talk to Xero.
XERO_CLIENT_ID=local-client-id-not-real
XERO_CLIENT_SECRET=local-test-secret-not-real
SYNC_INTERVAL_MINUTES=0
ENV
fi

cd "$ROOT"
node scripts/db-migrate.js >/dev/null

# Create the owner login the first time only.
if ! "$MYSQL" -h 127.0.0.1 -P "$PORT" -u root billhub_test \
      -e "SELECT 1 FROM users LIMIT 1" 2>/dev/null | grep -q 1; then
  OWNER_PASSWORD='billhub-local-test' node scripts/create-account.js \
    "Demo Group" owner@example.com 7 >/dev/null
  echo "Created the owner login."
fi

node test/seed.js >/dev/null
pkill -f "node server.js" 2>/dev/null || true
sleep 1
mkdir -p "$DATA"
node server.js > "$DATA/server.log" 2>&1 &

for _ in $(seq 1 20); do
  curl -sf "http://localhost:$APP_PORT/api/health" >/dev/null 2>&1 && break
  sleep 1
done

echo
echo "  Bills Hub   http://localhost:$APP_PORT   (no sign-in — AUTH_DISABLED)"
echo "  Logs        $DATA/server.log"
echo "  Stop        ./scripts/dev-local.sh --stop"
echo
