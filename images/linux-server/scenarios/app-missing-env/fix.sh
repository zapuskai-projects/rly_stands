#!/bin/sh
set -e
grep -q '^APP_SECRET=' /etc/app/app.env || echo 'APP_SECRET=training-secret' >> /etc/app/app.env
supervisorctl restart app >/dev/null
