-- 2026-03-06: Fix LMSR cumulative_stake initialization
-- Automatically computes the initial LMSR cost (cumulative_stake) for new events
-- and retroactively fixes existing uninitialized events.

BEGIN;

-- 1. Create a function to calculate LMSR cost
CREATE OR REPLACE FUNCTION set_initial_lmsr_cost() RETURNS TRIGGER AS $$
BEGIN
    -- If cumulative_stake is exactly 0.0 (the default), initialize it with LMSR cost formula
    IF NEW.cumulative_stake = 0.0 OR NEW.cumulative_stake IS NULL THEN
        NEW.cumulative_stake := NEW.liquidity_b * ln(exp(NEW.q_yes / NEW.liquidity_b) + exp(NEW.q_no / NEW.liquidity_b));
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Attach the trigger to the events table
DROP TRIGGER IF EXISTS trg_set_initial_lmsr_cost ON events;
CREATE TRIGGER trg_set_initial_lmsr_cost
BEFORE INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION set_initial_lmsr_cost();

-- 3. Retroactively fix existing events that were initialized with 0.0
UPDATE events 
SET cumulative_stake = liquidity_b * ln(exp(q_yes / liquidity_b) + exp(q_no / liquidity_b))
WHERE cumulative_stake = 0.0 OR cumulative_stake IS NULL;

COMMIT;
