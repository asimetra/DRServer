#!/usr/bin/env bash
# Brings the Postgres container up and down.
#
# docker-compose.yml describes the same thing, but not every machine has a
# compose provider — podman ships without one by default. This drives the
# container directly through whichever runtime is installed, so `npm run db:up`
# behaves the same either way.
set -euo pipefail

NAME=ods-postgres
IMAGE=postgres:16-alpine
DB=${ODS_DB_NAME:-${DR_DB_NAME:-open_dungeon}}
USER=${ODS_DB_USER:-${DR_DB_USER:-ods}}
PASSWORD=${ODS_DB_PASSWORD:-${DR_DB_PASSWORD:-ods}}
PORT=${ODS_DB_PORT:-${DR_DB_PORT:-5432}}
VOLUME=ods-pgdata

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

runtime() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo docker
  elif command -v podman >/dev/null 2>&1; then
    echo podman
  else
    echo "Neither docker nor podman is available." >&2
    exit 1
  fi
}

RT=$(runtime)

up() {
  if "$RT" container exists "$NAME" 2>/dev/null || "$RT" ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    "$RT" start "$NAME" >/dev/null
    echo "$NAME started (existing container, data preserved)"
  else
    "$RT" run -d --name "$NAME" \
      -e POSTGRES_DB="$DB" \
      -e POSTGRES_USER="$USER" \
      -e POSTGRES_PASSWORD="$PASSWORD" \
      -p "$PORT":5432 \
      -v "$VOLUME":/var/lib/postgresql/data \
      -v "$ROOT/db/schema.sql":/docker-entrypoint-initdb.d/schema.sql:ro,Z \
      "$IMAGE" >/dev/null
    echo "$NAME created on port $PORT; schema applied from db/schema.sql"
  fi

  printf 'waiting for postgres'
  for _ in $(seq 1 30); do
    if "$RT" exec "$NAME" pg_isready -U "$USER" -d "$DB" >/dev/null 2>&1; then
      echo " — ready"
      return 0
    fi
    printf '.'
    sleep 1
  done
  echo " — timed out" >&2
  exit 1
}

case "${1:-up}" in
  up)    up ;;
  down)  "$RT" stop "$NAME" >/dev/null && echo "$NAME stopped (data kept)" ;;
  psql)  shift; "$RT" exec -it "$NAME" psql -U "$USER" -d "$DB" "$@" ;;
  # Throws the volume away as well, so the schema is reapplied from scratch.
  reset) "$RT" rm -f "$NAME" >/dev/null 2>&1 || true
         "$RT" volume rm -f "$VOLUME" >/dev/null 2>&1 || true
         echo "$NAME and its data removed"; up ;;
  *)     echo "usage: db.sh [up|down|psql|reset]" >&2; exit 1 ;;
esac
