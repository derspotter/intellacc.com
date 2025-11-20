# Migration Guide

## Active migrations
- `initial_migration.sql`
- `006_migrate_to_ledger_units.sql`
- `007_add_user_positions_aggregates.sql`
- `add_weekly_assignment_system.sql`
- `20250812_add_device_credentials.sql`

## Deprecated (no-op) migrations
The following files remain in place so existing `schema_migrations` entries stay valid, but they no longer perform any changes:
- `008_add_messaging_system.sql`
- `009_optimize_messaging.sql`
- `20250212_add_encrypted_content_length_check.sql`
- `20250907_fix_conversation_view.sql`
- `20250909_align_predictions_schema.sql`
- `20250909_restore_messaging_schema.sql`
- `add_category_to_events.sql`
- `add_lmsr_market_tables.sql`

All functionality from the deprecated scripts has been consolidated into `initial_migration.sql`.
