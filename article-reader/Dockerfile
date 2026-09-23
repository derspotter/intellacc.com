FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
USER pwuser
ENV NODE_ENV=production
CMD ["node", "server.js"]
