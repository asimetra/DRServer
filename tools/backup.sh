#!/usr/bin/env bash
# Takes a copy of the accounts, and puts one back.
#
#   npm run backup                    a dated copy under backups/
#   npm run backup -- list            what has been kept
#   npm run backup -- restore <file>  put one back, over what is there now
#
# `db.sh reset` already dumps before it destroys, which is the one moment the
# data was certainly about to be lost. This is the other moment — every other
# one. A server that has been running for a month has no copy of anything, and
# `ods_data_dir_free_bytes` is monitored while nothing it measures is kept.
#
# Which backend is in use decides what a copy is: Postgres is a `pg_dump` taken
# inside the container, file storage is the data directory itself. Both land in
# the same place with the same name, so `list` reads either.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NAME=${ODS_DB_CONTAINER:-ods-postgres}
DB=${ODS_DB_NAME:-${DR_DB_NAME:-open_dungeon}}
DB_USER=${ODS_DB_USER:-${DR_DB_USER:-ods}}
DEST=${ODS_BACKUP_DIR:-$ROOT/backups}
DATA=${ODS_DATA_DIR:-$ROOT/data}

# Account data, so nobody else on the machine reads it. The directory is made
# before the first write rather than left to whichever command gets there first.
umask 077

# `.env` is where the settings actually live for most installs; the environment
# still wins, as it does for the server itself.
setting() {
  local name=$1 value="${!1:-}"
  if [[ -z "$value" && -r "$ROOT/.env" ]]; then
    # A name the file does not set is not an error, whatever pipefail thinks of grep.
    value=$({ grep -E "^[[:space:]]*$name=" "$ROOT/.env" || true; } | tail -1 | cut -d= -f2- | tr -d "\"' ")
  fi
  echo "$value"
}

storage_mode() {
  local value; value=$(setting ODS_STORAGE)
  echo "${value:-file}"
}

# The token signing secret, when it is a file. On file storage it is inside the
# data directory and the archive already has it. On PostgreSQL the database is
# everything else the server keeps, and this file is the one thing outside it:
# lose it and a restored server signs everybody out. Given as ODS_TOKEN_SECRET,
# there is no file to keep.
secret_file() {
  [[ -z "$(setting ODS_TOKEN_SECRET)" ]] && [[ -r "$DATA/token-secret" ]] && echo "$DATA/token-secret"
  return 0
}

runtime() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    echo docker
  elif command -v podman >/dev/null 2>&1; then
    echo podman
  else
    echo "Neither docker nor podman is available, so the database cannot be reached." >&2
    exit 1
  fi
}

require_container() {
  local rt=$1
  if ! "$rt" exec "$NAME" pg_isready -U "$DB_USER" -d "$DB" >/dev/null 2>&1; then
    echo "Container $NAME is not answering. Start it first: npm run db:up" >&2
    exit 1
  fi
}

stamp() { date -u +%Y%m%dT%H%M%SZ; }

# A name no backup has yet. Two taken in the same second shared one, and the
# second was written over the first — which is exactly what a restore did: the
# copy it takes of the current state, a moment after the backup it is about to
# put back, replaced that backup with the state it was meant to undo.
fresh_name() {
  local base="$DEST/accounts-$(stamp)" name n=1
  name=$base
  while compgen -G "$name.*" >/dev/null; do
    n=$((n + 1))
    name="$base-$n"
  done
  echo "$name"
}

backup() {
  mkdir -p "$DEST"
  local mode file
  mode=$(storage_mode)

  if [[ "$mode" == postgres ]]; then
    local rt; rt=$(runtime)
    require_container "$rt"
    file="$(fresh_name).sql"
    # Into a temporary name first: a half-written file that looks like a backup
    # is worse than no file, because it is the one somebody reaches for.
    if "$rt" exec "$NAME" pg_dump -U "$DB_USER" -d "$DB" > "$file.partial" && [[ -s "$file.partial" ]]; then
      mv "$file.partial" "$file"
    else
      rm -f "$file.partial"
      echo "pg_dump produced nothing; no backup was written." >&2
      exit 1
    fi
    local secret; secret=$(secret_file)
    if [[ -n "$secret" ]]; then
      cp "$secret" "${file%.sql}.token-secret"
      echo "token signing secret kept beside it: ${file%.sql}.token-secret"
    elif [[ -z "$(setting ODS_TOKEN_SECRET)" ]]; then
      echo "warning: no token-secret at $DATA/token-secret and no ODS_TOKEN_SECRET; the server's signing secret is not in this backup" >&2
    fi
  else
    if [[ ! -d "$DATA" ]]; then
      echo "No data directory at $DATA, so there is nothing to copy." >&2
      exit 1
    fi
    file="$(fresh_name).tar.gz"
    if tar -czf "$file.partial" -C "$(dirname "$DATA")" "$(basename "$DATA")" && [[ -s "$file.partial" ]]; then
      mv "$file.partial" "$file"
    else
      rm -f "$file.partial"
      echo "The data directory could not be archived; no backup was written." >&2
      exit 1
    fi
  fi

  echo "$mode backup written: $file ($(du -h "$file" | cut -f1))"
}

list() {
  if [[ ! -d "$DEST" ]] || [[ -z "$(ls -A "$DEST" 2>/dev/null)" ]]; then
    echo "No backups under $DEST."
    return 0
  fi
  ls -lh --time-style=+'%Y-%m-%d %H:%M' "$DEST" | tail -n +2
}

# Restoring is the destructive half, and it is the half nobody rehearses. So it
# names what it is about to overwrite and waits, and it takes a copy of the
# current state first — the usual way to lose an account is to restore the
# wrong file over a database that was fine.
restore() {
  local file=${1:-}
  if [[ -z "$file" ]]; then
    echo "usage: npm run backup -- restore <file>" >&2
    exit 1
  fi
  [[ -r "$file" ]] || { echo "Cannot read $file" >&2; exit 1; }

  local mode; mode=$(storage_mode)
  echo "About to restore $file over the current $mode data."
  if [[ -t 0 ]]; then
    read -r -p "Type RESTORE to go ahead: " answer
    [[ "$answer" == RESTORE ]] || { echo "Nothing was changed." >&2; exit 1; }
  elif [[ "${ODS_BACKUP_YES:-}" != "1" ]]; then
    echo "Not a terminal, so nothing was changed. Set ODS_BACKUP_YES=1 to confirm." >&2
    exit 1
  fi

  echo "taking a copy of the current state first"
  backup

  if [[ "$mode" == postgres ]]; then
    local rt; rt=$(runtime)
    require_container "$rt"
    # Dropped and remade rather than loaded on top: a dump restored over live
    # rows leaves whatever the dump does not mention, which is not the state the
    # backup was taken from.
    "$rt" exec -i "$NAME" psql -U "$DB_USER" -d postgres -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS $DB WITH (FORCE);" -c "CREATE DATABASE $DB OWNER $DB_USER;"
    "$rt" exec -i "$NAME" psql -U "$DB_USER" -d "$DB" -v ON_ERROR_STOP=1 < "$file"
    # And the secret beside it, if the backup kept one. The one being replaced is
    # set aside rather than overwritten: it is what signed every token out there.
    local kept="${file%.sql}.token-secret"
    if [[ "$file" == *.sql && -r "$kept" ]]; then
      mkdir -p "$DATA"
      if [[ -e "$DATA/token-secret" ]] && ! cmp -s "$kept" "$DATA/token-secret"; then
        mv "$DATA/token-secret" "$DATA/token-secret.replaced-$(stamp)"
        echo "previous token-secret moved to $DATA/token-secret.replaced-*"
      fi
      cp "$kept" "$DATA/token-secret"
      echo "token signing secret restored from $kept"
    fi
  else
    local keep="$DATA.replaced-$(stamp)"
    [[ -d "$DATA" ]] && mv "$DATA" "$keep" && echo "previous data directory moved to $keep"
    mkdir -p "$(dirname "$DATA")"
    tar -xzf "$file" -C "$(dirname "$DATA")"
  fi

  echo "restored from $file — restart the server so it reads the new state"
}

case "${1:-backup}" in
  backup)  backup ;;
  list)    list ;;
  restore) shift; restore "$@" ;;
  *)       echo "usage: backup.sh [backup|list|restore <file>]" >&2; exit 1 ;;
esac
