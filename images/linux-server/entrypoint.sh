#!/bin/sh
set -e
ssh-keygen -A >/dev/null
mkdir -p /run/sshd /var/log/app /var/uploads
chown app:student /var/log/app
chmod 2775 /var/log/app
touch /var/log/app/app.log
chown app:student /var/log/app/app.log
chmod 664 /var/log/app/app.log
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
