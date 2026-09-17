BEGIN;
-- Apply the bootstrap policy to new and still-pending questions.
-- Finalized history is preserved. Re-running cannot duplicate events or payouts.
ALTER TABLE market_question_submissions ALTER COLUMN required_validators SET DEFAULT 1;
ALTER TABLE market_question_submissions ALTER COLUMN required_approvals SET DEFAULT 1;
DO $$
DECLARE
  s market_question_submissions%ROWTYPE;
  total integer;
  approvals_count integer;
  approved boolean;
  new_event_id integer;
  outcome_row jsonb;
  outcome_id_new integer;
  outcome_count integer;
BEGIN
  FOR s IN SELECT * FROM market_question_submissions WHERE status = 'pending' ORDER BY id FOR UPDATE LOOP
    SELECT count(*), count(*) FILTER (WHERE vote = 'approve') INTO total, approvals_count
      FROM market_question_reviews WHERE submission_id = s.id;
    UPDATE market_question_submissions SET required_validators = 1, required_approvals = 1,
      total_reviews = total, approvals = approvals_count, rejections = total - approvals_count, updated_at = NOW() WHERE id = s.id;
    IF total = 0 THEN CONTINUE; END IF;
    IF s.creator_approval_reward_paid OR s.approved_event_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM market_question_reviews WHERE submission_id = s.id AND (settled_at IS NOT NULL OR payout_ledger <> 0)
    ) THEN RAISE EXCEPTION 'Pending submission % already has settlement data', s.id; END IF;
    approved := approvals_count >= 1;
    new_event_id := NULL;
    IF approved THEN
      INSERT INTO events (title, details, closing_date, category, event_type)
        VALUES (s.title, s.details, s.closing_date, s.category, s.event_type) RETURNING id INTO new_event_id;
      IF s.event_type <> 'binary' THEN
        outcome_count := jsonb_array_length(s.outcome_rows);
        IF outcome_count IS NULL OR outcome_count < 2 THEN RAISE EXCEPTION 'Missing outcomes for %', s.id; END IF;
        FOR outcome_row IN SELECT value FROM jsonb_array_elements(s.outcome_rows) LOOP
          INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
            VALUES (new_event_id, outcome_row->>'key', outcome_row->>'label', (outcome_row->>'sortOrder')::integer,
              (outcome_row->>'lowerBound')::double precision, (outcome_row->>'upperBound')::double precision)
            RETURNING id INTO outcome_id_new;
          INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
            VALUES (new_event_id, outcome_id_new, 0, 1.0 / outcome_count);
        END LOOP;
        UPDATE events SET market_prob = 1.0 / outcome_count, q_yes = 0, q_no = 0 WHERE id = new_event_id;
      END IF;
      UPDATE users SET rp_balance_ledger = rp_balance_ledger + s.creator_bond_ledger + 10000000 WHERE id = s.creator_user_id;
      IF s.source_post_id IS NOT NULL THEN
        INSERT INTO post_market_links (post_id, event_id, stance, source, confirmed, match_method, confirmed_count)
          SELECT id, new_event_id, 'related', CASE WHEN user_id = s.creator_user_id THEN 'author_confirmed' ELSE 'reader_suggested' END,
            TRUE, 'manual', 1 FROM posts WHERE id = s.source_post_id
          ON CONFLICT (post_id, event_id) DO NOTHING;
      END IF;
    END IF;
    UPDATE market_question_reviews SET payout_ledger = CASE WHEN (vote = 'approve') = approved THEN 5000000 ELSE 0 END,
      settled_at = NOW() WHERE submission_id = s.id;
    UPDATE users SET rp_balance_ledger = rp_balance_ledger + 5000000 WHERE id IN (
      SELECT reviewer_user_id FROM market_question_reviews WHERE submission_id = s.id AND (vote = 'approve') = approved
    );
    UPDATE market_question_submissions SET status = CASE WHEN approved THEN 'approved' ELSE 'rejected' END,
      approved_event_id = new_event_id, creator_approval_reward_paid = approved, finalized_at = NOW(), updated_at = NOW() WHERE id = s.id;
  END LOOP;
END $$;

COMMIT;
