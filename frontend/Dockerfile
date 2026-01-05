# Use the official Node.js 23 Alpine image as the base
FROM node:23-alpine

# Set environment variable to indicate we're in Docker
ENV DOCKER_ENV=true
ENV NODE_ENV=development

# Set the working directory inside the container
WORKDIR /app

# Copy package.json (and package-lock.json if available)
COPY package*.json ./

# Copy local packages
COPY openmls-pkg ./openmls-pkg

# Install dependencies (include optional native bindings for Alpine)
RUN npm install && npm install @rollup/rollup-linux-x64-musl --save-optional

# Copy the rest of your frontend source code
COPY . .

# Expose the port Vite uses (default is 5173)
EXPOSE 5173

# Run Vite in development mode (hot-reload enabled)
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]