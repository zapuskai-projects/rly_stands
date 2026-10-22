#!/bin/sh
set -e
label="${1:?нужна метка}"
request_id="req-$(printf '%s' "$label" | md5sum | cut -c1-10)"
log=/var/log/app/app.log
now=$(date +%s)
i=0
while [ "$i" -lt 120 ]; do
  ts=$(date -u -d "@$((now - 120 + i))" +%Y-%m-%dT%H:%M:%S.000Z)
  rid="req-$(printf '%s-%s' "$label" "$i" | md5sum | cut -c1-10)"
  if [ $((i % 29)) -eq 7 ]; then
    echo "$ts WARN requestId=$rid POST /api/upload 400 3ms" >> "$log"
  else
    echo "$ts INFO requestId=$rid GET /api/items 200 $((i % 37 + 2))ms" >> "$log"
  fi
  if [ "$i" -eq 83 ]; then
    echo "$ts ERROR requestId=$request_id POST /api/payments 500 2104ms payment gateway timeout" >> "$log"
  fi
  i=$((i + 1))
done
