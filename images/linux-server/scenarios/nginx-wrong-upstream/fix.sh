#!/bin/sh
set -e
sed -i 's#proxy_pass http://127.0.0.1:[0-9]*;#proxy_pass http://127.0.0.1:3000;#' /etc/nginx/conf.d/app.conf
nginx -s reload
