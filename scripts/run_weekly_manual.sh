#!/bin/bash

# Manual Weekly Assignment Runner
# Use this script to manually run weekly processes for testing or emergency runs

echo "🔧 Manual Weekly Assignment Process"
echo "=================================="

# Check if backend is running
if ! docker ps | grep intellacc_backend > /dev/null; then
    echo "❌ Backend container is not running. Please start it first:"
    echo "   docker compose -f docker-compose-dev.yml up -d"
    exit 1
fi

echo "✅ Backend container is running"

# Copy the script to the backend container and run it
echo "📋 Copying weekly script to backend container..."
docker cp scripts/weekly_cron.js intellacc_backend:/usr/src/app/

echo "🚀 Running weekly processes inside backend container..."
docker exec intellacc_backend node weekly_cron.js

echo "🎉 Manual weekly process completed!"
echo ""
echo "📊 You can check the backend logs with:"
echo "   docker logs intellacc_backend --tail 50"