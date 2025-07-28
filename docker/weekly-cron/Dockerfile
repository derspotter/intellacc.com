FROM node:18-alpine

# Install cron
RUN apk add --no-cache dcron

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy cron script
COPY scripts/weekly_cron.js .
RUN chmod +x weekly_cron.js

# Create crontab file
RUN echo "0 2 * * 1 /usr/local/bin/node /usr/src/app/weekly_cron.js >> /var/log/weekly_cron.log 2>&1" > /etc/crontabs/root

# Ensure log file exists
RUN touch /var/log/weekly_cron.log

# Start cron daemon
CMD ["crond", "-f", "-l", "2"]