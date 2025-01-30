# Use the official Node.js 18 Alpine image as the base
FROM node:23-alpine

# Install PostgreSQL client
RUN apk add --no-cache postgresql-client

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Force re-install dependencies inside the container
RUN rm -rf node_modules && npm install

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the app
CMD ["npm", "start"]
