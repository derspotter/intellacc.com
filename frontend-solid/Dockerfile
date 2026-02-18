FROM node:23-alpine

ENV DOCKER_ENV=true
ENV NODE_ENV=development

WORKDIR /app

COPY package*.json ./
RUN npm install && npm install @rollup/rollup-linux-x64-musl --save-optional

COPY . .

EXPOSE 4174

CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "4174"]
