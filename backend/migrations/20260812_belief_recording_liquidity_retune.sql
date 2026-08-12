-- Belief recording + liquidity retune (2026-08-12)
--
-- 1. market_updates.belief_prob: the trader's stated P(YES) at trade time
--    (the request's target_prob, which the frontend now sends as a real
--    belief instead of the 0.99/0.01 direction sentinel). Nullable: numeric
--    and multi-outcome trades don't carry a binary belief, and historical
--    rows predate the field.
--
-- 2. Liquidity retune: b=5000 made trades invisible (median 78 RP stake
--    moved a binary market <1pp; reaching a belief 17pp away costs ~2000 RP).
--    b=1000 gives a median trade ~4pp of visible impact while capping a
--    full-starting-balance (1000 RP) all-in at ~82% from a 50% start.
--    Applies to BINARY markets only; numeric/multiple_choice/date market
--    UX was built against b=5000 and is retuned separately if at all.
--
--    Safety: b is only changed where q_yes = q_no = 0 and no trades exist —
--    price is softmax(q/b), so touching b on a market with nonzero q would
--    silently reprice it and revalue open positions.
--
-- 3. Per-type default via BEFORE INSERT trigger (column default can't
--    depend on event_type). All current creation paths (Rust importer,
--    predictionsController, marketQuestionController) omit liquidity_b and
--    previously inherited DEFAULT 5000; the trigger keeps that behavior for
--    non-binary types and gives binary markets 1000. Explicit non-NULL
--    liquidity_b in an INSERT is always respected.

ALTER TABLE market_updates ADD COLUMN IF NOT EXISTS belief_prob DOUBLE PRECISION;

ALTER TABLE events ALTER COLUMN liquidity_b DROP DEFAULT;

CREATE OR REPLACE FUNCTION set_default_liquidity_b() RETURNS trigger AS $$
BEGIN
  IF NEW.liquidity_b IS NULL THEN
    IF NEW.event_type IS NULL OR NEW.event_type = 'binary' THEN
      NEW.liquidity_b := 1000.0;
    ELSE
      NEW.liquidity_b := 5000.0;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_default_liquidity_b ON events;
CREATE TRIGGER trg_events_default_liquidity_b
  BEFORE INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION set_default_liquidity_b();

UPDATE events e
SET liquidity_b = 1000.0
WHERE e.event_type = 'binary'
  AND COALESCE(e.q_yes, 0) = 0
  AND COALESCE(e.q_no, 0) = 0
  AND e.liquidity_b IS DISTINCT FROM 1000.0
  AND NOT EXISTS (SELECT 1 FROM market_updates mu WHERE mu.event_id = e.id);
