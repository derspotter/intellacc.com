FROM node:20-alpine

WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies including devDependencies
RUN npm install --legacy-peer-deps

# Copy application code
COPY . .

# Expose the primary frontend port
EXPOSE 5173

# Command to run the dev server
CMD ["npm", "run", "dev", "--", "--host"]
