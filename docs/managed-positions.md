# Daily managed positions

Binary market tickets in both layouts offer **Automatically manage** alongside the existing probability and quarter/half/full Kelly controls. Enabling management schedules the first adjustment. It does not place an immediate trade. Changing the probability or Kelly choice requires **Save management settings**. The saved choice belongs to that market and is independent of the account's default Kelly preference.

The default check is once per day at **00:00 UTC**. The UI shows the next check in the user's local time. New settings apply at the next boundary. Pausing takes effect as soon as its request completes, leaves all holdings intact, and permits manual trading again. Manual binary buys and sells are rejected while management is enabled so the manager cannot undo a manual exit. The engine honors the backend's `PHONE_VERIFICATION_ENABLED` setting when enforcing phone verification.

Each daily check may buy, reduce, or switch between YES and NO, using the saved belief and available account RP. Kelly is an exposure preference, not a fixed spending cap. The calculation uses available cash plus this position's liquidation value. RP invested in other markets is unavailable, and correlations between different markets are not modeled. Management continues until paused, the market closes/resolves, or the account loses the required phone verification tier. It continues using the saved belief until the user changes it.

Full Kelly maximizes expected log terminal wealth with LMSR price impact. Fractional Kelly scales the resulting share position. A hypothetical liquidation removes the user's holdings from the price used for sizing; only the difference between current and desired holdings is executed. This prevents the manager from repeatedly reacting to its own fills. Adjustments smaller than 0.01 RP per leg are skipped. Existing holding periods apply and may prevent a day's adjustment. Execution retains the existing one-million-RP buy and ten-million-share per-leg limits.

Each adjustment, including a sell followed by a buy, commits in one database transaction. The existing ledger functions perform accounting. Activity is retained in `managed_position_activity`, and the UI displays the latest adjustment or the reason management is waiting. Event locks serialize management with manual trading, pausing, and resolution. A transaction-scoped advisory lock prevents overlapping worker passes. Persisted daily slots prevent duplicate checks after a restart. The worker catches up a missed check on startup, processing eligible policies in batches of 128 until all have been checked.

`MANAGED_POSITION_INTERVAL_SECONDS` is an optional server setting. The default is `86400`; supported overrides range from `3600` to `604800`. Invalid values fall back to daily. The scheduler aligns intervals to UTC epoch boundaries. The UI reads the effective interval and next boundary from the API. Its periodic read only refreshes the display and never initiates a trade.

Deployment requires the additive `backend/migrations/20260907_managed_positions.sql` migration before starting the updated engine, then the updated backend and frontend. No existing position is enrolled automatically. The engine tolerates the missing table during a staged rollout, while the management endpoint remains unavailable until its migration is applied.

Validation:

- Backend: `docker exec intellacc_backend npm test -- --runInBand test/managed_positions.test.js` (mocked HTTP tests, no database writes).
- Engine: in a Rust test container, `cargo test --bin prediction_engine managed_ -- --nocapture`. Set `TEST_DB_ADMIN_URL` and `TEST_DB_URL` to an isolated PostgreSQL instance and mount the migration directory at `/backend/migrations`, or set `MANAGED_POSITION_MIGRATION_PATH`. The tests create and clean up disposable databases.
- Browser: serve the frontend with Vite, then run `npx playwright test tests/e2e/managed-position.spec.js` in a browser test container with `E2E_BASE_URL` pointing at that dev server. Both ticket layouts use a dedicated fixture with mocked API responses and no real trades.
