# Benchmark Plan (Prediction Engine)

## Goals
- Establish a repeatable baseline for production-performance.
- Measure throughput and latency under the current architecture.
- Track changes with one variable per iteration.

## Baseline Workload
- Users: 1000
- Events: 1000
- Trades per user: 1000 (1,000,000 total)
- Batch size: 100
- Build: release
- DB: Postgres in Docker (test_intellacc)
- Isolation: SERIALIZABLE (current)
- Pool max connections: 50

## Metrics to Capture
- Total duration
- TPS (throughput)
- Success rate
- DB CPU %
- DB connection saturation
- WAL rate (optional)

## Checklist (Per Run)
- [ ] Ensure no other stress runs are active
- [ ] Start database
- [ ] Run release stress test
- [ ] Capture logs
- [ ] Record metrics below

## Baseline Results
- Date: 2026-01-19T15:49:54+01:00
- Commit: 1274b1f
- Command: docker compose -f prediction-engine/docker-compose.test.yml run --rm prediction-engine-tests bash -c "export PATH=/usr/local/cargo/bin:$PATH; export PGPASSWORD=password; export RUST_LOG=info; until pg_isready -h db -U postgres; do sleep 1; done; cargo test --release stress::tests::test_comprehensive_market_simulation -- --nocapture"
- Duration: 392.25s
- TPS: 2549.37
- Success rate: 32.52% (325,216 ok / 674,784 failed)
- Notes: DB CPU saturated; high failure rate implies balance checks or insufficient funds are frequent under current parameters.

## Iteration Log
- Change:
- Date:
- Commit:
- Command:
- Duration:
- TPS:
- Success rate:
- Notes:
