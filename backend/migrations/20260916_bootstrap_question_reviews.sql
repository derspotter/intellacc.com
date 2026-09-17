-- Bootstrap defaults. Existing submissions retain the review terms they were created with.
ALTER TABLE market_question_submissions ALTER COLUMN required_validators SET DEFAULT 2;
ALTER TABLE market_question_submissions ALTER COLUMN required_approvals SET DEFAULT 2;
