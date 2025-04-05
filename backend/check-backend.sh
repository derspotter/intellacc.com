#!/bin/bash

echo "===== Backend Service Diagnostics ====="

# Check if backend container is running
echo "Checking backend container status..."
if docker ps | grep -q intellacc_backend; then
  echo "✓ Backend container is running"
else
  echo "✗ Backend container is not running!"
  echo "Starting backend container..."
  docker-compose up -d backend
  sleep 5
fi

# Check if backend is listening on port 3000
echo "Checking if backend is listening on port 3000..."
docker exec intellacc_backend netstat -tulpn | grep 3000
if [ $? -eq 0 ]; then
  echo "✓ Backend is listening on port 3000"
else
  echo "✗ Backend is NOT listening on port 3000!"
  echo "Checking Node.js application configuration..."
  
  # Try to find the main application file
  MAIN_FILE=$(docker exec intellacc_backend find /usr/src/app -name "*.js" -exec grep -l "app.listen" {} \;)
  echo "Main application file appears to be: $MAIN_FILE"
fi

# Attempt to connect from frontend to backend
echo "Attempting to connect from frontend to backend..."
docker exec intellacc_frontend curl -v http://intellacc_backend:3000/

echo "===== End of Diagnostics ====="
