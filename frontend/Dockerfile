# Use Node.js 22 LTS for stable Vitest/jsdom behavior
FROM node:22-alpine

# Set environment variable to indicate we're in Docker
ENV DOCKER_ENV=true
ENV NODE_ENV=development

# Set the working directory inside the container
WORKDIR /app

# Copy package.json (and package-lock.json if available)
COPY package*.json ./

# Copy the frontend source. The shared OpenMLS package is mounted at runtime via `/shared`.
COPY . .

# Expose the port Vite uses (default is 5173)
EXPOSE 5173

# Run Vite in development mode (hot-reload enabled)
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
