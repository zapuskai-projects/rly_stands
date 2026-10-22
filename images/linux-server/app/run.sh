#!/bin/sh
set -a
. /etc/app/app.env
set +a
exec python3 /opt/app/app.py
