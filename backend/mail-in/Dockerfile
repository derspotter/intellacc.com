FROM alpine:3.20

RUN apk add --no-cache postfix openssl

COPY main.cf /etc/postfix/main.cf
COPY vmailbox /etc/postfix/vmailbox
COPY entrypoint.sh /entrypoint.sh
# alpine's postfix package already provides the vmail user; entrypoint
# resolves its uid/gid at start.
RUN chmod +x /entrypoint.sh

EXPOSE 25
ENTRYPOINT ["/entrypoint.sh"]
