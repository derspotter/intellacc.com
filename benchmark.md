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
- Date:
- Commit:
- Command:
- Duration:
- TPS:
- Success rate:
- Notes:

## Iteration Log
- Change:
- Date:
- Commit:
- Command:
- Duration:
- TPS:
- Success rate:
- Notes:
