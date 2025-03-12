# Use the official Node.js 23 Alpine image as the base
FROM node:23-alpine

# Set the working directory inside the container
WORKDIR /app

# Copy package.json (and package-lock.json if available)
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of your frontend source code
COPY . .

# Expose the port Vite uses (default is 5173)
EXPOSE 5173

# Run Vite in development mode (hot-reload enabled)
CMD ["npm", "run", "dev"]