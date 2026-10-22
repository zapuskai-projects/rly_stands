#!/bin/sh
set -e
sed -i '/^APP_SECRET=/d' /etc/app/app.env
supervisorctl restart app >/dev/null || true
