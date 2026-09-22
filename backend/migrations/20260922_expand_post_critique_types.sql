-- Keep fresh installations aligned with the critique schema used by the model.
BEGIN;
ALTER TABLE post_critiques DROP CONSTRAINT IF EXISTS post_critiques_critique_type_check;
ALTER TABLE post_critiques ADD CONSTRAINT post_critiques_critique_type_check CHECK (
  critique_type IN (
    'unsupported_causal_claim', 'contradiction', 'ambiguous_timeframe',
    'unfalsifiable', 'missing_base_rate', 'cherry_picked_evidence',
    'false_dichotomy', 'appeal_to_authority', 'circular_reasoning',
    'non_sequitur', 'hasty_generalization', 'empirical_error',
    'unsupported_assumption', 'data_mismatch', 'logical_leap',
    'methodological_flaw', 'overgeneralization', 'confounding_variable',
    'unsubstantiated_mechanism', 'conceptual_ambiguity'
  )
);
COMMIT;
