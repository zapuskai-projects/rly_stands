#!/bin/sh
set -e
filesystem=$(df -P /var/log/app | tail -1 | awk '{print $1}')
if [ "$filesystem" != "tmpfs" ]; then
  echo "раздел логов не ограничен по размеру, сценарий не применён" >&2
  exit 1
fi
dd if=/dev/zero of=/var/log/app/app.log.1.huge bs=1M 2>/dev/null || true
