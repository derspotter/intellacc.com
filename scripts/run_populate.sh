#!/bin/bash

# Database Population Script Runner
# This script runs the database population in a Docker container with proper networking

echo "🚀 Starting database population script..."
echo "📋 This will generate:"
echo "   👥 1000 random users with realistic profiles"
echo "   🔗 Social network follow relationships"
echo "   📅 200 diverse events across multiple categories"
echo "   🎯 5000+ predictions with varied accuracy"
echo "   💬 500 posts + 800 comments for feed testing"
echo "   🏆 Calculated reputation scores for all users"
echo ""

# Check if the intellacc network exists
if ! docker network ls | grep -q intellacc-network; then
    echo "Creating Docker network..."
    docker network create intellacc-network
fi

# Check if database is running
if ! docker ps | grep -q intellacc_db; then
    echo "❌ Database container is not running!"
    echo "Please start the database first with:"
    echo "   ./scripts/dev-stack.sh up"
    exit 1
fi

echo "🔧 Installing dependencies and running population script..."

# Run the population script in a temporary Node.js container
docker run --rm \
    --network intellacc-network \
    -v "$(pwd):/workspace" \
    -w /workspace/scripts \
    node:18-alpine \
    sh -c "
        echo 'Installing dependencies...'
        npm install --silent
        echo 'Running population script...'
        node populate_database.js
    "

echo ""
echo "✅ Database population completed!"
echo "🌐 You can now test the application with realistic data:"
echo "   Frontend: http://localhost:5173"
echo "   Backend API: http://localhost:3000/api"
echo ""
echo "🧪 Recommended testing:"
echo "   1. Check leaderboards with different filters"
echo "   2. Browse the feed with reputation-based ranking"
echo "   3. View user profiles with reputation scores"
echo "   4. Test follow/unfollow functionality"
echo "   5. Create new predictions and see live updates"
