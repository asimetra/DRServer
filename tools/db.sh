#!/usr/bin/env bash
# Brings the Postgres container up and down.
#
# docker-compose.yml describes the same thing, but not every machine has a
# compose provider — podman ships without one by default. This drives the
# container directly through whichever runtime is installed, so `npm run db:up`
# behaves the same either way.
set -euo pipefail

NAME=${ODS_DB_CONTAINER:-ods-postgres}
IMAGE=postgres:16-alpine
DB=${ODS_DB_NAME:-${DR_DB_NAME:-open_dungeon}}
DB_USER=${ODS_DB_USER:-${DR_DB_USER:-ods}}
PASSWORD=${ODS_DB_PASSWORD:-${DR_DB_PASSWORD:-ods}}
PORT=${ODS_DB_PORT:-${DR_DB_PORT:-5432}}
VOLUME=${ODS_DB_VOLUME:-ods-pgdata}
# Loopback only. The game server reaches the database on 127.0.0.1 and nothing
# else needs to: a port published on every interface, with the password above,
# hands every account to whoever shares the network — and a container
# runtime's published ports are not something a host firewall reliably covers.
BIND=${ODS_DB_BIND:-127.0.0.1}

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
    # An existing container keeps the address it was created with, and this
    # script used to publish on every interface.
    if "$RT" port "$NAME" 5432/tcp 2>/dev/null | grep -qE '^(0\.0\.0\.0|\[?::\]?):'; then
      echo "note: $NAME publishes the database on every network interface." >&2
      echo "      To bind it to loopback, recreate it — the data volume is kept:" >&2
      echo "        $RT rm -f $NAME && npm run db:up" >&2
    fi
  else
    "$RT" run -d --name "$NAME" \
      --restart unless-stopped \
      -e POSTGRES_DB="$DB" \
      -e POSTGRES_USER="$DB_USER" \
      -e POSTGRES_PASSWORD="$PASSWORD" \
      -p "$BIND":"$PORT":5432 \
      -v "$VOLUME":/var/lib/postgresql/data \
      -v "$ROOT/db/schema.sql":/docker-entrypoint-initdb.d/schema.sql:ro,Z \
      "$IMAGE" >/dev/null
    echo "$NAME created on $BIND:$PORT; schema applied from db/schema.sql"
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

# Throws the volume away as well, so the schema is reapplied from scratch.
#
# Every account lives in that volume. This used to run the moment it was typed,
# one word away from `db:down`, with nothing kept. Now it says what it is about
# to delete and waits to be told, and writes a dump first. If the dump cannot be
# taken it stops there, unless --no-dump says the copy is not wanted.
reset() {
  local confirmed=0 dumpless=0 argument
  for argument in "$@"; do
    case "$argument" in
      --yes) confirmed=1 ;;
      --no-dump) dumpless=1 ;;
      *) echo "usage: db.sh reset [--yes] [--no-dump]" >&2; exit 1 ;;
    esac
  done

  if (( ! confirmed )); then
    echo "This deletes container $NAME and volume $VOLUME: every account stored in it." >&2
    if [[ ! -t 0 ]]; then
      echo "Not a terminal, so nothing was removed. Pass --yes to confirm: npm run db:reset -- --yes" >&2
      exit 1
    fi
    read -r -p "Type the volume name ($VOLUME) to go ahead: " answer
    if [[ "$answer" != "$VOLUME" ]]; then
      echo "Nothing was removed." >&2
      exit 1
    fi
  fi

  if "$RT" container exists "$NAME" 2>/dev/null || "$RT" ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
    local dump="$ROOT/data/db-before-reset-$(date -u +%Y%m%dT%H%M%SZ).sql"
    mkdir -p "$ROOT/data"
    "$RT" start "$NAME" >/dev/null 2>&1 || true
    for _ in $(seq 1 15); do
      "$RT" exec "$NAME" pg_isready -U "$DB_USER" -d "$DB" >/dev/null 2>&1 && break
      sleep 1
    done
    if (umask 077 && "$RT" exec "$NAME" pg_dump -U "$DB_USER" -d "$DB" > "$dump") 2>/dev/null && [[ -s "$dump" ]]; then
      echo "dump of the old database kept at $dump"
    else
      rm -f "$dump"
      # A dump can fail for reasons that have nothing to do with the data being
      # lost already — the wrong user in this shell, a directory that cannot be
      # written — so failing to take one is not permission to go on without.
      if (( ! dumpless )); then
        echo "The old database could not be dumped, so nothing was removed." >&2
        echo "Fix that and run it again, or pass --no-dump to delete it without a copy." >&2
        exit 1
      fi
      echo "the old database could not be dumped; removing it without a copy, as asked" >&2
    fi
  fi

  "$RT" rm -f "$NAME" >/dev/null 2>&1 || true
  "$RT" volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  echo "$NAME and its data removed"
  up
}

case "${1:-up}" in
  up)    up ;;
  down)  "$RT" stop "$NAME" >/dev/null && echo "$NAME stopped (data kept)" ;;
  psql)  shift; "$RT" exec -it "$NAME" psql -U "$DB_USER" -d "$DB" "$@" ;;
  reset) shift; reset "$@" ;;
  *)     echo "usage: db.sh [up|down|psql|reset [--yes] [--no-dump]]" >&2; exit 1 ;;
esac
