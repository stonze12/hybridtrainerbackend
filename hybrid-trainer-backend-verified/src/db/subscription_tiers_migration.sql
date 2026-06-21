-- ============================================================================
-- SUBSCRIPTION TIERS MIGRATION
-- Replaces the original generic 'pro' membership concept with two named
-- tiers (Fighter / Competitor) and adds monthly per-feature allowance
-- tracking, since subscriptions unlock a bundled monthly AI usage
-- allowance ON TOP OF (not instead of) Training Credits, per the
-- locked-in business model.
--
-- Run this against your live Supabase database via SQL Editor. Safe to
-- run on a database that already has the original schema applied —
-- uses IF NOT EXISTS / ADD VALUE IF NOT EXISTS throughout.
-- ============================================================================

-- Step 1: extend membership_type with the two real tier names.
-- 'pro' is kept (not removed) for backward compatibility with any
-- existing rows — Postgres can't drop enum values without recreating
-- the type, which isn't worth the risk on a live database for an
-- unused legacy value.
ALTER TYPE membership_type ADD VALUE IF NOT EXISTS 'fighter';
ALTER TYPE membership_type ADD VALUE IF NOT EXISTS 'competitor';

-- Step 2: monthly allowance tracking — one row per (user, billing
-- period), tracking how much of each bundled feature they've used
-- this cycle. Reset happens naturally: a new period_start means a new
-- row, rather than zeroing out an existing one, which keeps a clean
-- historical record of usage per cycle for free.
CREATE TABLE IF NOT EXISTS subscription_allowance_usage (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id     UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    period_start        TIMESTAMPTZ NOT NULL,
    period_end          TIMESTAMPTZ NOT NULL,
    ai_coach_question_used     INTEGER NOT NULL DEFAULT 0,
    custom_training_plan_used  INTEGER NOT NULL DEFAULT 0,
    fight_camp_builder_used    INTEGER NOT NULL DEFAULT 0,
    sparring_review_used       INTEGER NOT NULL DEFAULT 0,
    opponent_analysis_used     INTEGER NOT NULL DEFAULT 0,
    nutrition_plan_used        INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_allowance_usage_user_period
    ON subscription_allowance_usage (user_id, period_start DESC);

-- Step 3: atomic "use one unit of allowance if available" function —
-- same atomic-row-update pattern as the existing credit deduction
-- functions, for the same reason: prevents a race condition where two
-- simultaneous requests both read "1 remaining" and both proceed.
CREATE OR REPLACE FUNCTION use_allowance(
    p_user_id UUID,
    p_subscription_id UUID,
    p_period_start TIMESTAMPTZ,
    p_period_end TIMESTAMPTZ,
    p_feature TEXT,
    p_monthly_limit INTEGER
) RETURNS TABLE (success BOOLEAN, used_after INTEGER) AS $$
DECLARE
    v_column TEXT := p_feature || '_used';
    v_current INTEGER;
BEGIN
    -- Ensure a usage row exists for this billing period (idempotent —
    -- ON CONFLICT means a concurrent request creating the same row is
    -- harmless, not an error).
    INSERT INTO subscription_allowance_usage (user_id, subscription_id, period_start, period_end)
    VALUES (p_user_id, p_subscription_id, p_period_start, p_period_end)
    ON CONFLICT (user_id, period_start) DO NOTHING;

    -- Atomic conditional update: only increments if currently under
    -- the limit, in a single statement, so concurrent requests can't
    -- both pass the same check and both increment past the limit.
    EXECUTE format(
        'UPDATE subscription_allowance_usage
         SET %I = %I + 1, updated_at = now()
         WHERE user_id = $1 AND period_start = $2 AND %I < $3
         RETURNING %I',
        v_column, v_column, v_column, v_column
    ) INTO v_current USING p_user_id, p_period_start, p_monthly_limit;

    IF v_current IS NULL THEN
        -- Update affected 0 rows — limit already reached. Return the
        -- current (unchanged) count for the caller to display.
        EXECUTE format('SELECT %I FROM subscription_allowance_usage WHERE user_id = $1 AND period_start = $2', v_column)
        INTO v_current USING p_user_id, p_period_start;
        RETURN QUERY SELECT FALSE, COALESCE(v_current, 0);
    ELSE
        RETURN QUERY SELECT TRUE, v_current;
    END IF;
END;
$$ LANGUAGE plpgsql;
