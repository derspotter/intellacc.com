# syntax=docker/dockerfile:1.7
# Use the official Node.js 23 Alpine image as the base
FROM node:23-alpine

# Install PostgreSQL client (no build toolchain)
RUN apk add --no-cache postgresql-client

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and npmrc for faster, quieter installs
COPY package*.json .npmrc ./

# Install dependencies with cache + lockfile support (npm ci if lockfile exists)
ARG NPM_LOGLEVEL=error
RUN --mount=type=cache,target=/root/.npm \
    sh -lc 'npm install --no-fund --no-audit --loglevel=${NPM_LOGLEVEL}'

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Use nodemon for hot-reloading in development
CMD ["npm", "run", "dev"]
