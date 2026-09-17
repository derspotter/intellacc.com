# Legacy numeric imports stored as binary

The old Metaculus import endpoints inserted events without `event_type`. PostgreSQL
therefore assigned `binary`, even when the description recorded `Type: numeric`.
They now use the shared typed importer, which seeds numeric bins or choice outcomes.
Existing records are not silently converted during import.

## Explicit repair

Save the original event, outcomes and outcome states before applying a repair.
Obtain the original Metaculus **post** JSON and verify its nested `question.id`
against the exact `Metaculus ID:` line in the event. Post and question IDs can differ.
For event 170, question 40904 is in post 41177. The verified source has range
30–70, unit %, and both open tails. Archived duplicate event 7333 stays archived.

In a container with the database environment and the saved JSON mounted:

```sh
repair_legacy_numeric 170 /data/metaculus-post.json
repair_legacy_numeric 170 /data/metaculus-post.json --apply
```

The default is a transactional dry run. The tool locks the event and refuses
conversion if it is resolved, has shares, predictions, trades, resolution proposals,
managed positions, nonzero quantities, or non-binary outcomes. Invalid source
ranges roll back all changes. Repeating a completed repair leaves it unchanged.
It reuses the ordinary numeric seeder, including log transforms and tail outcomes.
The event ID, links, title and closing date are preserved.

Restart/invalidate the engine cache after a live repair, then verify both
`GET /api/events/170` and `GET /api/events/170/market`, and the distribution UI.
Do not unarchive or merge duplicate imports as part of a type correction.

## Regression test

Restore the production **schema only**, without data, into a disposable test
PostgreSQL database whose name ends in `_test`. Run inside the Rust container:

```sh
cargo test --release --lib -- --skip stress::tests::test_comprehensive_market_simulation
NUMERIC_REPAIR_TEST_URL=postgres://.../numeric_repair_test cargo test --release --lib legacy_numeric_regression -- --ignored --nocapture
```

The integration test covers numeric, discrete and multiple-choice imports,
repeat imports, mismatched provider IDs, invalid bounds with rollback, dry-run
rollback, refusal with user shares, successful conversion and idempotence.
