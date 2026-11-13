#!/bin/sh
set -eu

KIT_DIR=$(cd -P "$(dirname "$0")/.." && pwd -P)
cd "$KIT_DIR"
PANEL=stands-kit-panel
PREVIOUS=stands-kit-panel-previous
PORT=18490
ORIGIN="http://127.0.0.1:$PORT"
PLATFORM_URL=${STAND_PLATFORM_URL:-https://api.education.zapuskai.com}
if command -v shasum >/dev/null 2>&1; then
  FINGERPRINT=$(printf %s "$KIT_DIR" | shasum -a 256 | cut -d ' ' -f1)
else
  FINGERPRINT=$(printf %s "$KIT_DIR" | sha256sum | cut -d ' ' -f1)
fi

fail() { echo "$*" >&2; exit 1; }
version() { tr -d ' \r\n' < "$KIT_DIR/VERSION"; }
panel_image() { printf '%s\n' "${STAND_PULT_IMAGE:-ghcr.io/zapuskai-projects/stands-kit-pult:$1}"; }
exists() { docker container inspect "$1" >/dev/null 2>&1; }
owned() {
  [ "$(docker inspect --format '{{index .Config.Labels "stands.kit.panel.path"}}' "$1")" = "$FINGERPRINT" ] &&
  [ "$(docker inspect --format '{{index .Config.Labels "stands.kit.controller"}}' "$1")" = 1 ]
}
panel_cmd() { docker exec "$PANEL" node /app/dist/main.js panel "$@"; }
healthy() {
  COUNT=0
  until panel_cmd meta >/dev/null 2>&1 && { ! command -v curl >/dev/null 2>&1 || curl -fsS --max-time 2 "$ORIGIN/api/meta" >/dev/null 2>&1; }; do
    COUNT=$((COUNT+1))
    [ "$COUNT" -lt 30 ] || return 1
    sleep 1
  done
  owned "$PANEL" && [ "$(docker port "$PANEL" 18490/tcp)" = "127.0.0.1:18490" ]
}

create_panel() {
  if [ "$(docker image inspect --format '{{index .Config.Labels "stands.kit.panel.protocol"}}' "$(panel_image "$1")")" != 1 ]; then
    echo "В выбранном образе отсутствует браузерная панель. Для проверки исходников из текущей папки:" >&2
    echo "docker build -t stands-kit-pult:local ./pult && STAND_PULT_IMAGE=stands-kit-pult:local ./stand panel" >&2
    return 1
  fi
  if ! CREATED_ID=$(docker create --name "$PANEL" --restart unless-stopped --init \
    --label stands.kit.controller=1 --label "stands.kit.panel.path=$FINGERPRINT" \
    --network stands-kit --add-host host.docker.internal:host-gateway \
    -p "127.0.0.1:$PORT:$PORT" \
    -v /var/run/docker.sock:/var/run/docker.sock -v stands-kit-data:/data \
    -v "$KIT_DIR":/kit -w /kit \
    -e "KIT_FINGERPRINT=$FINGERPRINT" -e "KIT_HOST_DIR=$KIT_DIR" -e "KIT_VERSION=$1" \
    -e "STAND_PLATFORM_URL=$PLATFORM_URL" -e STAND_LINUX_IMAGE -e STAND_BANK_IMAGE \
    -e STAND_PULT_IMAGE -e STAND_MEMORY_TOTAL_MB -e KIT_AGENT_INTERVAL_SEC \
    -e "KIT_PANEL_HANDOFF=${2:-}" "$(panel_image "$1")" panel serve); then
    owned "$PANEL" && healthy
    return $?
  fi
  if ! docker start "$CREATED_ID" >/dev/null; then
    docker rm "$CREATED_ID" >/dev/null 2>&1 || true
    return 1
  fi
}

ensure_panel() {
  if exists "$PANEL"; then
    owned "$PANEL" || fail "Порт пульта занят набором из другой папки. Запустите ./stand в исходной папке."
    if [ "$(docker inspect --format '{{.State.Running}}' "$PANEL")" != true ]; then docker start "$PANEL" >/dev/null || { restore_panel || fail "Не удалось запустить контроллер."; }; fi
  elif exists "$PREVIOUS"; then
    owned "$PREVIOUS" || fail "Обнаружен контроллер другого набора."
    docker rename "$PREVIOUS" "$PANEL"
    docker start "$PANEL" >/dev/null
  else
    create_panel "$(version)" || {
      fail "Не удалось открыть пульт на 127.0.0.1:$PORT. Проверьте Docker и свободен ли порт."
    }
  fi
  if ! healthy; then
    if exists "$PREVIOUS" && owned "$PREVIOUS"; then
      restore_panel || fail "Не удалось восстановить предыдущий пульт. Проверьте docker logs $PANEL."
    else
      fail "Контроллер не отвечает на $ORIGIN. Проверьте docker logs $PANEL."
    fi
  fi
}

restore_panel() {
  exists "$PREVIOUS" && owned "$PREVIOUS" || return 1
  if exists "$PANEL"; then owned "$PANEL" && docker rm -f "$PANEL" >/dev/null || return 1; fi
  docker rename "$PREVIOUS" "$PANEL" && docker start "$PANEL" >/dev/null && healthy
}

replace_panel() {
  IDENT=$1
  TARGET=$2
  REASON="Не удалось обновить файлы набора"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -n "$(git status --porcelain)" ]; then
    REASON="В папке набора есть незакоммиченные изменения"
    return 1
  fi
  if [ "$(version)" != "$TARGET" ]; then
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
    git fetch -q && [ "$(git show '@{upstream}:VERSION' | tr -d ' \r\n')" = "$TARGET" ] || return 1
    git pull --ff-only || return 1
  fi
  REASON="Требуемая версия или образ отсутствует"
  [ "$(version)" = "$TARGET" ] && docker image inspect "$(panel_image "$TARGET")" >/dev/null || return 1
  if [ "$(docker inspect --format '{{.Config.Image}}' "$PANEL")" = "$(panel_image "$TARGET")" ] &&
     [ "$(panel_cmd bridge version)" = "$TARGET" ]; then
    healthy || return 1
  else
    if exists "$PREVIOUS"; then
      owned "$PREVIOUS" || return 1
      return 1
    fi
    REASON="Не удалось заменить контейнер пульта или проверить его готовность"
    docker stop "$PANEL" >/dev/null && docker rename "$PANEL" "$PREVIOUS" || return 1
    if ! create_panel "$TARGET" "$IDENT" || ! healthy; then
      restore_panel || echo "Не удалось восстановить предыдущий контроллер. Повторите ./stand panel." >&2
      return 1
    fi
  fi
  REASON="Новый контроллер не подтвердил обновление стендов"
  panel_cmd bridge complete "$BRIDGE_PID" "$IDENT" "$TARGET" || return 1
  if exists "$PREVIOUS" && owned "$PREVIOUS"; then docker rm "$PREVIOUS" >/dev/null; fi
}

ensure_panel
NONCE=$(panel_cmd bootstrap) || fail "Не удалось получить ссылку для входа в пульт."
case "$NONCE" in ''|*[!a-zA-Z0-9_-]*) fail "Контроллер вернул неверную ссылку входа.";; esac
URL="$ORIGIN/#bootstrap=$NONCE"
printf 'Локальный пульт: %s\n' "$URL"
if [ "${STAND_NO_BROWSER:-0}" != 1 ]; then
  if [ -n "${STAND_OPEN_COMMAND:-}" ]; then "$STAND_OPEN_COMMAND" "$URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1 && [ "$(uname -s)" = Darwin ]; then open "$URL" || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
fi
unset NONCE URL
BRIDGE_PID=$$
trap 'exit 0' INT TERM HUP
trap 'panel_cmd bridge release "$BRIDGE_PID" >/dev/null 2>&1 || true' EXIT
while :; do
  if REQUEST=$(panel_cmd bridge tick "$BRIDGE_PID"); then
    case "$REQUEST" in
      busy:*)
        OTHER=${REQUEST#busy:}
        case "$OTHER" in ''|*[!0-9]*) fail "Недопустимый идентификатор процесса.";; esac
        if kill -0 "$OTHER" 2>/dev/null; then echo "Обновления уже обслуживает другой запущенный ./stand."; exit 0; fi
        panel_cmd bridge reclaim "$BRIDGE_PID" "$OTHER" >/dev/null ;;
      idle) ;;
      *" "*)
        IDENT=${REQUEST%% *}
        TARGET=${REQUEST#* }
        case "$IDENT" in ''|*[!a-zA-Z0-9_-]*) fail "Некорректный идентификатор обновления.";; esac
        case "$TARGET" in ''|*[!0-9.]*|.*|*..*) fail "Некорректная версия обновления.";; esac
        if ! replace_panel "$IDENT" "$TARGET"; then
          panel_cmd bridge failed "$BRIDGE_PID" "$IDENT" "$TARGET" "$REASON" || true
          echo "Не удалось обновить пульт. Подробности доступны в истории." >&2
        fi ;;
      *) fail "Контроллер вернул неизвестный ответ." ;;
    esac
  fi
  sleep 3
done
