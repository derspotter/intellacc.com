#!/bin/bash
# Script to build and run stress test using Docker

set -e

echo "🚀 Building and Running LMSR Stress Test in Docker"
echo "=================================================="

# Build a temporary image with dev dependencies
echo "Building test image with cargo..."
docker build -t prediction-engine-test -f - . <<EOF
FROM rust:1.75-alpine

# Install build dependencies
RUN apk add --no-cache musl-dev openssl-dev pkgconfig

# Create app directory
WORKDIR /app

# Copy source code
COPY . .

# Set environment for building
ENV RUSTFLAGS="-C target-feature=-crt-static"

CMD ["cargo", "run", "--bin", "stress_test"]
EOF

# Run the stress test
echo -e "\nRunning stress test..."
docker run --rm \
    --network intellacc-network \
    -e DATABASE_URL="postgresql://intellacc_user:supersecretpassword@intellacc_db:5432/test_intellacc" \
    -e RUST_LOG="info,prediction_engine=debug" \
    prediction-engine-test

echo -e "\n✅ Stress test completed!"