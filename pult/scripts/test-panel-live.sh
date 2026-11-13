#!/bin/sh
set -eu

: "${RUNNER_TEMP:?Запустите проверку на изолированном CI runner}"
[ "${RUNNER_ENVIRONMENT:-}" = github-hosted ] || { echo "Для этого теста нужен одноразовый Docker runner." >&2; exit 1; }
if [ -n "$(docker ps -aq --filter name=stands-kit)" ] || [ -n "$(docker volume ls -q --filter name=stands-kit)" ] || docker network inspect stands-kit >/dev/null 2>&1; then
  echo "Docker уже содержит стенды. Тест требует пустого окружения." >&2; exit 1
fi

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CASE=$(mktemp -d "$RUNNER_TEMP/stand-panel.XXXXXX")
KIT="$CASE/student kit"
ORIGIN="$CASE/releases.git"
SOURCE="$CASE/source"
V1=0.0.901
V2=0.0.902
EVIDENCE="$RUNNER_TEMP/panel-proof"
umask 077

git clone -q --no-local "$ROOT" "$SOURCE"
git -C "$SOURCE" config user.name "Panel test"
git -C "$SOURCE" config user.email "panel@localhost"
git -C "$SOURCE" switch -q -c panel-test
set_version() {
  printf '%s\n' "$1" > "$SOURCE/VERSION"
  (cd "$SOURCE/pult" && npm version "$1" --no-git-tag-version --allow-same-version >/dev/null)
}
build() { docker build -q -t "ghcr.io/zapuskai-projects/stands-kit-pult:$1" "$SOURCE/pult" >/dev/null; }
set_version "$V1"
git -C "$SOURCE" commit -qam "Panel test V1"
git clone -q --bare --single-branch -b panel-test "$SOURCE" "$ORIGIN"
git clone -q "$ORIGIN" "$KIT"
build "$V1"
docker build -q -t "ghcr.io/zapuskai-projects/stands-kit-linux:$V1" "$SOURCE/images/linux-server" >/dev/null
set_version "$V2"
printf '\ndocument.documentElement.dataset.testRelease = "V2";\n' >> "$SOURCE/pult/web/main.ts"
git -C "$SOURCE" commit -qam "Panel test V2 assets"
git -C "$SOURCE" push -q "$ORIGIN" panel-test
build "$V2"
docker build -q -t stands-kit-bank:panel-test "$ROOT/bank" >/dev/null
mkdir -p "$KIT/work" "$EVIDENCE"
printf 'amount: 100\n' > "$KIT/work/transfer.yaml"
docker network create stands-kit >/dev/null
docker run -d --name panel-test-platform --network stands-kit -v "$ROOT/pult/tests/panel-platform.mjs:/app/platform.mjs:ro" node:22-alpine node /app/platform.mjs >/dev/null
export STAND_PLATFORM_URL=http://panel-test-platform:18599
export STAND_BANK_IMAGE=stands-kit-bank:panel-test
export STAND_NO_BROWSER=1
sh "$KIT/stand" panel > "$CASE/launcher.log" 2>&1 &
LAUNCHER=$!
trap 'kill "$LAUNCHER" 2>/dev/null || true' EXIT
TRIES=0
until curl -fsS --max-time 2 http://127.0.0.1:18490/api/meta >/dev/null 2>&1; do
  TRIES=$((TRIES+1))
  if [ "$TRIES" -gt 90 ] || ! kill -0 "$LAUNCHER" 2>/dev/null; then
    sed -E 's/(bootstrap=)[A-Za-z0-9_-]+/\1***/g' "$CASE/launcher.log" >&2
    exit 1
  fi
  sleep 1
done
node "$ROOT/pult/tests/panel-live.mjs" "$KIT" "$EVIDENCE"
