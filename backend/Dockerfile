# Use the official Node.js 23 Alpine image as the base
FROM node:23-alpine

# Install PostgreSQL client
RUN apk add --no-cache postgresql-client

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and npmrc for faster, quieter installs
COPY package*.json .npmrc ./

# Install dependencies with less output
RUN npm install --no-fund --no-audit --loglevel=error

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the app
CMD ["npm", "start"]
