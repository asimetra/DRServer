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
DB_USER=${ODS_DB_USER:-${DR_DB_USER:-ods}}
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

has_configured_subid_ranges() {
  local account subid_file
  account=$(id -un)

  for subid_file in /etc/subuid /etc/subgid; do
    [[ -r "$subid_file" ]] || return 1
    awk -F: -v account="$account" '
      $1 == account && ($3 + 0) > 1 { found = 1 }
      END { exit(found ? 0 : 1) }
    ' "$subid_file" || return 1
  done
}

podman_userns_is_stale() {
  [[ "$RT" == podman ]] || return 1
  [[ $("$RT" info --format '{{.Host.Security.Rootless}}' 2>/dev/null) == true ]] || return 1
  has_configured_subid_ranges || return 1

  # A healthy rootless namespace has the caller at container ID 0 and at
  # least one subordinate range after it. A lone `0 <uid> 1` mapping makes
  # crun fail while mounting /dev/pts for Postgres.
  ! "$RT" unshare cat /proc/self/uid_map 2>/dev/null | awk '
    $1 != 0 && ($3 + 0) > 1 { found = 1 }
    END { exit(found ? 0 : 1) }
  '
}

refresh_podman_userns() {
  podman_userns_is_stale || return 0

  local running_containers
  running_containers=$("$RT" ps --format '{{.Names}}')
  if [[ -n "$running_containers" ]]; then
    echo "Podman rootless UID/GID mapping is stale, but refreshing it would stop running containers:" >&2
    printf '  %s\n' $running_containers >&2
    echo "Stop those containers, then run npm run db:up again." >&2
    return 1
  fi

  echo "refreshing stale Podman rootless UID/GID mapping"
  "$RT" system migrate

  if podman_userns_is_stale; then
    echo "Podman still cannot see the subordinate UID/GID ranges from /etc/subuid and /etc/subgid." >&2
    echo "Run 'podman system migrate' after logging out and back in, then retry." >&2
    return 1
  fi
}

up() {
  refresh_podman_userns

  if "$RT" container exists "$NAME" 2>/dev/null || "$RT" ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    "$RT" start "$NAME" >/dev/null
    echo "$NAME started (existing container, data preserved)"
  else
    "$RT" run -d --name "$NAME" \
      -e POSTGRES_DB="$DB" \
      -e POSTGRES_USER="$DB_USER" \
      -e POSTGRES_PASSWORD="$PASSWORD" \
      -p "$PORT":5432 \
      -v "$VOLUME":/var/lib/postgresql/data \
      -v "$ROOT/db/schema.sql":/docker-entrypoint-initdb.d/schema.sql:ro,Z \
      "$IMAGE" >/dev/null
    echo "$NAME created on port $PORT; schema applied from db/schema.sql"
  fi

  printf 'waiting for postgres'
  for _ in $(seq 1 30); do
    if "$RT" exec "$NAME" pg_isready -U "$DB_USER" -d "$DB" >/dev/null 2>&1; then
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
  psql)  shift; "$RT" exec -it "$NAME" psql -U "$DB_USER" -d "$DB" "$@" ;;
  # Throws the volume away as well, so the schema is reapplied from scratch.
  reset) "$RT" rm -f "$NAME" >/dev/null 2>&1 || true
         "$RT" volume rm -f "$VOLUME" >/dev/null 2>&1 || true
         echo "$NAME and its data removed"; up ;;
  *)     echo "usage: db.sh [up|down|psql|reset]" >&2; exit 1 ;;
esac
