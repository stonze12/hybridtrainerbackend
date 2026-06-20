-- ============================================================================
-- ATOMIC CREDIT DEDUCTION
--
-- Why this needs to be a single SQL statement / stored procedure rather than
-- "read balance in app code, check it, then write new balance":
--
-- If two requests from the same user hit the API in parallel (e.g. they
-- double-tap a button, or a retry fires while the original is still in
-- flight), a naive read-then-write in application code has a race window:
--   Request A reads credits = 10
--   Request B reads credits = 10
--   Request A checks 10 >= 5 -> OK, writes credits = 5
--   Request B checks 10 >= 5 -> OK, writes credits = 5  (should have failed!)
-- Both requests proceed, but only one deduction actually "stuck" — the user
-- got a free AI call. At 100k+ users this WILL happen regularly, not as an
-- edge case.
--
-- The fix: do the check-and-deduct in one atomic UPDATE ... WHERE clause.
-- Postgres guarantees the WHERE check and the write happen atomically under
-- row-level locking, so the second concurrent request's UPDATE simply
-- matches zero rows and fails cleanly.
-- ============================================================================

CREATE OR REPLACE FUNCTION deduct_credits(
    p_user_id UUID,
    p_amount INTEGER,
    p_action credit_action,
    p_reference_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL
) RETURNS TABLE (success BOOLEAN, new_balance BIGINT, transaction_id UUID) AS $$
DECLARE
    v_new_balance BIGINT;
    v_transaction_id UUID;
BEGIN
    -- The atomic part: UPDATE...WHERE credits >= p_amount. If another
    -- transaction already dropped the balance below p_amount, this UPDATE
    -- matches zero rows and v_new_balance stays NULL — no race window exists
    -- because Postgres takes a row lock for the duration of this UPDATE.
    UPDATE users
    SET credits = credits - p_amount,
        credits_version = credits_version + 1
    WHERE id = p_user_id
      AND credits >= p_amount
    RETURNING credits INTO v_new_balance;

    IF v_new_balance IS NULL THEN
        -- Either the user doesn't exist, or balance was insufficient.
        RETURN QUERY SELECT FALSE, NULL::BIGINT, NULL::UUID;
        RETURN;
    END IF;

    -- Append to the ledger. This row is the permanent audit record;
    -- users.credits is just a cache that this function keeps in sync.
    INSERT INTO credit_transactions (user_id, action, credits_delta, balance_after, reference_id, metadata)
    VALUES (p_user_id, p_action, -p_amount, v_new_balance, p_reference_id, p_metadata)
    RETURNING id INTO v_transaction_id;

    RETURN QUERY SELECT TRUE, v_new_balance, v_transaction_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- CREDIT GRANT (purchases, subscription renewals, signup bonus, refunds)
-- Simpler than deduction since there's no "insufficient balance" failure
-- mode, but still atomic and still ledgered for the same audit reasons.
-- ============================================================================

CREATE OR REPLACE FUNCTION grant_credits(
    p_user_id UUID,
    p_amount INTEGER,
    p_action credit_action,
    p_reference_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT NULL
) RETURNS TABLE (new_balance BIGINT, transaction_id UUID) AS $$
DECLARE
    v_new_balance BIGINT;
    v_transaction_id UUID;
BEGIN
    UPDATE users
    SET credits = credits + p_amount,
        credits_version = credits_version + 1
    WHERE id = p_user_id
    RETURNING credits INTO v_new_balance;

    INSERT INTO credit_transactions (user_id, action, credits_delta, balance_after, reference_id, metadata)
    VALUES (p_user_id, p_action, p_amount, v_new_balance, p_reference_id, p_metadata)
    RETURNING id INTO v_transaction_id;

    RETURN QUERY SELECT v_new_balance, v_transaction_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- RECONCILIATION QUERY — run nightly. If this ever returns rows, the cached
-- balance in `users.credits` has drifted from the ledger truth and you have
-- a bug to find before it compounds. Alert on any non-empty result.
-- ============================================================================

CREATE OR REPLACE VIEW credit_balance_reconciliation AS
SELECT
    u.id AS user_id,
    u.credits AS cached_balance,
    COALESCE(SUM(ct.credits_delta), 0) + 0 AS ledger_balance, -- signup bonus is itself a ledger row, no offset needed
    u.credits - (COALESCE(SUM(ct.credits_delta), 0)) AS drift
FROM users u
LEFT JOIN credit_transactions ct ON ct.user_id = u.id
GROUP BY u.id, u.credits
HAVING u.credits != COALESCE(SUM(ct.credits_delta), 0);
