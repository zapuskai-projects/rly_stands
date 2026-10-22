FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl iproute2 less lsof nano net-tools nginx openssh-server procps python3 sudo supervisor \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/nginx/sites-enabled/default
RUN groupadd -g 2001 app \
  && groupadd -g 2002 student \
  && useradd -u 2001 -g app -d /opt/app -s /usr/sbin/nologin app \
  && useradd -u 2002 -g student -G adm -m -s /bin/bash student \
  && echo 'student:student' | chpasswd \
  && mkdir -p /etc/app /opt/app /opt/scenarios /var/log/app /var/uploads /run/sshd
COPY app/app.py app/run.sh /opt/app/
COPY app.env /etc/app/app.env
COPY nginx-app.conf /etc/nginx/conf.d/app.conf
COPY supervisord.conf /etc/supervisor/supervisord.conf
COPY sshd_config /etc/ssh/sshd_config.d/kit.conf
COPY student.sudoers /etc/sudoers.d/student
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scenarios /opt/scenarios
RUN chmod 0440 /etc/sudoers.d/student \
  && chmod 0755 /opt/app/run.sh /usr/local/bin/entrypoint.sh \
  && find /opt/scenarios -name '*.sh' -exec chmod 0755 {} + \
  && chown root:student /etc/app /etc/nginx/conf.d /etc/app/app.env /etc/nginx/conf.d/app.conf \
  && chmod 0775 /etc/app /etc/nginx/conf.d \
  && chmod 0664 /etc/app/app.env /etc/nginx/conf.d/app.conf \
  && chown app:app /var/uploads \
  && chmod 0775 /var/uploads \
  && chown app:student /var/log/app \
  && chmod 2775 /var/log/app
EXPOSE 22 80
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
