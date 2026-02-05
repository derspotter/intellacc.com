FROM node:18-alpine

ARG SUPERCRONIC_VERSION=0.2.33

RUN apk add --no-cache ca-certificates curl

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy cron script
COPY scripts/weekly_cron.js .
RUN chmod +x weekly_cron.js

# Install supercronic (container-friendly cron)
RUN set -eux; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64) super_arch="linux-amd64" ;; \
    aarch64|arm64) super_arch="linux-arm64" ;; \
    armv7l) super_arch="linux-arm" ;; \
    *) echo "Unsupported arch: $arch" && exit 1 ;; \
  esac; \
  curl -fsSL -o /usr/local/bin/supercronic "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-${super_arch}"; \
  chmod +x /usr/local/bin/supercronic

# Create cron schedule (Mondays 02:00 UTC)
RUN mkdir -p /etc/supercronic \
  && echo "0 2 * * 1 /usr/local/bin/node /usr/src/app/weekly_cron.js" > /etc/supercronic/cronjobs

CMD ["supercronic", "-no-reap", "/etc/supercronic/cronjobs"]
