#!/bin/sh
set -e

# Virtual delivery runs under a bare numeric uid — no passwd entry needed.
mkdir -p /etc/postfix/tls /var/mail
chown 5000:5000 /var/mail
postconf -e "virtual_uid_maps = static:5000"
postconf -e "virtual_gid_maps = static:5000"

if [ ! -f /etc/postfix/tls/cert.pem ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=mail.intellacc.com" \
    -keyout /etc/postfix/tls/key.pem -out /etc/postfix/tls/cert.pem
fi

postmap lmdb:/etc/postfix/vmailbox
newaliases 2>/dev/null || true

exec postfix start-fg
