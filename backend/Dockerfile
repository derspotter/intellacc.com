# syntax=docker/dockerfile:1.7
# Use the official Node.js 25 Alpine image as the base
FROM node:25-alpine

# Install PostgreSQL client (no build toolchain)
RUN apk add --no-cache postgresql-client

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package manifests first for better cache behavior
COPY package*.json .npmrc ./

# Install all dependencies from lockfile during image build so runtime can start quickly
RUN --mount=type=cache,target=/root/.npm \
    sh -lc 'npm ci --no-fund --no-audit --loglevel=error'

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Use dev entrypoint for migrations/watcher
CMD ["./scripts/docker-dev-entrypoint.sh"]
