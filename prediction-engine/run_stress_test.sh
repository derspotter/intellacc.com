#!/bin/bash
# Script to run the stress test in Docker

echo "🚀 Running LMSR Prediction Engine Stress Test"
echo "============================================="

# Set database URL for test database
export DATABASE_URL="postgresql://intellacc_user:supersecretpassword@intellacc_db:5432/test_intellacc"
export RUST_LOG="info,prediction_engine=debug"

# Build the stress test in the dev container
docker compose -f docker-compose.yml exec prediction_engine_dev bash -c "
    cd /app && \
    export DATABASE_URL='$DATABASE_URL' && \
    export RUST_LOG='$RUST_LOG' && \
    cargo run --bin stress_test
"