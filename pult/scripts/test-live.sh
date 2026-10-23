#!/bin/sh
set -eu

PULT_DIR=$(cd "$(dirname "$0")/.." && pwd)
KIT_DIR=$(cd "$PULT_DIR/.." && pwd)
GROUPS_LIST=${*:-messaging data contracts camunda bank monitoring}
NETWORK=stands-kit
SECRET=live-$$-$(date +%s)
PROJECT=stands-kit-live
IMAGE=stands-kit-pult-live:dev

for tool in docker; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Нужен $tool" >&2; exit 1; }
done

if [ -n "$(docker ps -aq --filter name='^stands-kit')" ] || [ -n "$(docker volume ls -q --filter name='^stands-kit')" ]; then
  echo "На этом компьютере уже есть контейнеры или тома stands-kit: сначала ./stand reset, потом живые тесты." >&2
  exit 1
fi

services_for() {
  case "$1" in
    messaging) echo "rabbitmq redpanda" ;;
    data) echo "postgres elasticsearch clickhouse redpanda" ;;
    contracts) echo "plantuml" ;;
    camunda) echo "operaton" ;;
    bank) echo "postgres redpanda rabbitmq kit-bank-core kit-bank-antifraud kit-bank-sbp" ;;
    monitoring) echo "prometheus grafana demo-app postgres redpanda rabbitmq kit-bank-core kit-bank-antifraud kit-bank-sbp" ;;
    *) echo "неизвестная группа $1" >&2; exit 1 ;;
  esac
}

SERVICES=""
for group in $GROUPS_LIST; do
  SERVICES="$SERVICES $(services_for "$group")"
done
SERVICES=$(echo "$SERVICES" | tr ' ' '\n' | awk 'NF && !seen[$0]++' | tr '\n' ' ')

export KIT_HOST_DIR="$KIT_DIR"
export KIT_VERSION=live
export STAND_PULT_IMAGE=stands-kit-pult:dev
export STAND_LINUX_IMAGE=stands-kit-linux:dev
export STAND_BANK_IMAGE=${STAND_BANK_IMAGE:-stands-kit-bank:dev}
export KIT_SECRET="$SECRET"

created_network=0
docker network inspect "$NETWORK" >/dev/null 2>&1 || { docker network create "$NETWORK" >/dev/null; created_network=1; }
docker volume create stands-kit-data >/dev/null

compose() {
  docker compose -p "$PROJECT" -f "$KIT_DIR/compose.yaml" \
    --profile rabbitmq --profile kafka --profile postgres --profile elasticsearch --profile clickhouse \
    --profile contracts --profile camunda --profile bank --profile monitoring "$@"
}

cleanup() {
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm stands-kit-data >/dev/null 2>&1 || true
  [ "$created_network" = 1 ] && docker network rm "$NETWORK" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker build --target live -t "$IMAGE" "$PULT_DIR"
compose up -d --no-deps $SERVICES

LIST=$(echo "$GROUPS_LIST" | tr ' ' ',')
status=0
docker run --rm --network "$NETWORK" \
  -e KIT_LIVE="$LIST" \
  -e KIT_LIVE_BANK_SECRET="$SECRET" \
  "$IMAGE" "src/**/*.live.ts" || status=$?

if [ "$status" -ne 0 ]; then
  for container in $(docker ps -aq --filter name='^stands-kit-bank-'); do
    echo "--- $(docker inspect -f '{{.Name}}' "$container") ---" >&2
    docker logs --tail 40 "$container" 2>&1 | grep '"level":"\(error\|warn\)"' | tail -15 >&2 || true
  done
fi
exit "$status"
