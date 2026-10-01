#!/usr/bin/env bash
# Brings up graphs and alerts for a running DR Server: Prometheus, which
# collects what the server says on /metrics and keeps it, and Grafana, which
# draws it. Optional — the server needs neither, and `curl /healthz` or an
# uptime monitor is enough for a small one.
#
# Like tools/db.sh, this drives the containers directly so that it behaves the
# same under docker and podman.
set -euo pipefail

# One name for the container and for the volume that keeps its data.
PROMETHEUS=${ODS_PROMETHEUS_CONTAINER:-ods-prometheus}
GRAFANA=${ODS_GRAFANA_CONTAINER:-ods-grafana}
PROMETHEUS_IMAGE=docker.io/prom/prometheus:v3.5.0
GRAFANA_IMAGE=docker.io/grafana/grafana:12.1.0
PROMETHEUS_PORT=${ODS_PROMETHEUS_PORT:-9090}
GRAFANA_PORT=${ODS_GRAFANA_PORT:-3000}
# Loopback only, like the database: neither has been given a password worth
# the name, and what they show is how this server is built and who is on it.
BIND=${ODS_MONITOR_BIND:-127.0.0.1}

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONFIG="$ROOT/monitoring"

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

exists() {
  "$RT" container exists "$1" 2>/dev/null || "$RT" ps -a --format '{{.Names}}' | grep -qx "$1"
}

wait_for() { # name url
  printf 'waiting for %s' "$1"
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 -o /dev/null "$2" 2>/dev/null; then
      echo " — ready"
      return 0
    fi
    printf '.'
    sleep 1
  done
  echo " — timed out" >&2
  return 1
}

up() {
  # On the host's network, not a bridge: the server's status listener is bound
  # to loopback, and that is not reachable from a network of the container's own.
  if exists "$PROMETHEUS"; then
    "$RT" start "$PROMETHEUS" >/dev/null
  else
    "$RT" run -d --name "$PROMETHEUS" --restart unless-stopped --network host \
      -v "$CONFIG/prometheus.yml":/etc/prometheus/prometheus.yml:ro,Z \
      -v "$CONFIG/alerts.yml":/etc/prometheus/alerts.yml:ro,Z \
      -v "$PROMETHEUS":/prometheus \
      "$PROMETHEUS_IMAGE" \
      --config.file=/etc/prometheus/prometheus.yml \
      --storage.tsdb.path=/prometheus \
      --storage.tsdb.retention.time=30d \
      --web.listen-address="$BIND:$PROMETHEUS_PORT" >/dev/null
  fi

  if exists "$GRAFANA"; then
    "$RT" start "$GRAFANA" >/dev/null
  else
    "$RT" run -d --name "$GRAFANA" --restart unless-stopped --network host \
      -e ODS_PROMETHEUS_PORT="$PROMETHEUS_PORT" \
      -e GF_SERVER_HTTP_ADDR="$BIND" \
      -e GF_SERVER_HTTP_PORT="$GRAFANA_PORT" \
      -e GF_AUTH_ANONYMOUS_ENABLED=true \
      -e GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
      -e GF_ANALYTICS_REPORTING_ENABLED=false \
      -e GF_ANALYTICS_CHECK_FOR_UPDATES=false \
      -e GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH=/etc/grafana/dashboards/dr-server.json \
      -v "$CONFIG/grafana/provisioning/datasources":/etc/grafana/provisioning/datasources:ro,Z \
      -v "$CONFIG/grafana/provisioning/dashboards":/etc/grafana/provisioning/dashboards:ro,Z \
      -v "$CONFIG/grafana/dashboards":/etc/grafana/dashboards:ro,Z \
      -v "$GRAFANA":/var/lib/grafana \
      "$GRAFANA_IMAGE" >/dev/null
  fi

  wait_for prometheus "http://$BIND:$PROMETHEUS_PORT/-/ready"
  wait_for grafana "http://$BIND:$GRAFANA_PORT/api/health"
  echo "dashboard:  http://$BIND:$GRAFANA_PORT/"
  echo "prometheus: http://$BIND:$PROMETHEUS_PORT/  (targets and alerts)"
}

case "${1:-up}" in
  up)    up ;;
  down)  "$RT" stop "$GRAFANA" "$PROMETHEUS" >/dev/null && echo "monitoring stopped (history kept)" ;;
  # Removes the containers so the next `up` picks up edited configuration or
  # ports. The collected history lives in the volumes and stays.
  recreate) "$RT" rm -f "$GRAFANA" "$PROMETHEUS" >/dev/null 2>&1 || true; up ;;
  *)     echo "usage: monitor.sh [up|down|recreate]" >&2; exit 1 ;;
esac
