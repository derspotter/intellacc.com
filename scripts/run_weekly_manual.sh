#!/bin/bash

# Manual Weekly Assignment Runner
# Use this script to manually run weekly processes for testing or emergency runs

echo "🔧 Manual Weekly Assignment Process"
echo "=================================="

# Check if backend is running
backend_container=""
if docker ps --filter "name=^/intellacc_backend$" --format '{{.Names}}' | grep -q '^intellacc_backend$'; then
  backend_container="intellacc_backend"
elif docker ps --filter "name=^/intellacc_backend_dev$" --format '{{.Names}}' | grep -q '^intellacc_backend_dev$'; then
  backend_container="intellacc_backend_dev"
else
    echo "❌ Backend container is not running. Please start it first:"
    echo "   ./scripts/dev-stack.sh up"
    exit 1
fi

echo "✅ Backend container is running: $backend_container"

# Copy the script to the backend container and run it
echo "📋 Copying weekly script to backend container..."
docker cp scripts/weekly_cron.js "$backend_container":/usr/src/app/

echo "🚀 Running weekly processes inside backend container..."
if [ -n "$WEEKLY_ADMIN_TOKEN" ]; then
  echo "Using WEEKLY_ADMIN_TOKEN for auth"
elif [ -n "$WEEKLY_ADMIN_EMAIL" ] && [ -n "$WEEKLY_ADMIN_PASSWORD" ]; then
  echo "Using WEEKLY_ADMIN_EMAIL/WEEKLY_ADMIN_PASSWORD for auth"
else
  echo "⚠️  Admin auth missing. Set WEEKLY_ADMIN_TOKEN or WEEKLY_ADMIN_EMAIL/WEEKLY_ADMIN_PASSWORD."
fi
docker exec "$backend_container" node weekly_cron.js

echo "🎉 Manual weekly process completed!"
echo ""
echo "📊 You can check the backend logs with:"
echo "   docker logs intellacc_backend --tail 50"
