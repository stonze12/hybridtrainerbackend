-- ============================================================================
-- HYBRID TRAINER — CREDIT + SUBSCRIPTION SYSTEM
-- PostgreSQL 15+ schema
--
-- Design notes:
--   - credits stored as BIGINT (not float) — never use floating point for
--     a balance that gates paid API calls. Fractional credits are not a
--     concept in this design.
--   - Every credit-changing operation MUST go through credit_transactions
--     as an atomic, append-only ledger. users.credits is a cached running
--     total, not the source of truth — the ledger is the source of truth.
--     This is the standard "ledger + cached balance" pattern used by every
--     real payments system, and it's what lets you reconcile / audit later.
--   - All monetary amounts stored in cents (INTEGER), never decimal/float.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- USERS
-- ----------------------------------------------------------------------------
CREATE TYPE membership_type AS ENUM ('free', 'pro', 'admin');

CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email               CITEXT UNIQUE NOT NULL,              -- CITEXT = case-insensitive, prevents dupe accounts via case
    username            VARCHAR(32) UNIQUE NOT NULL,
    password_hash       VARCHAR(255) NOT NULL,                -- bcrypt/argon2 hash, never plaintext
    membership_type     membership_type NOT NULL DEFAULT 'free',
    credits             BIGINT NOT NULL DEFAULT 0,             -- cached balance; ledger in credit_transactions is truth. No free signup credits by design — see auth_service.js.
    credits_version     BIGINT NOT NULL DEFAULT 0,             -- optimistic-lock counter, see credit deduction logic
    email_verified      BOOLEAN NOT NULL DEFAULT FALSE,
    stripe_customer_id  VARCHAR(255) UNIQUE,                   -- set on first Stripe interaction
    failed_login_count  INTEGER NOT NULL DEFAULT 0,
    locked_until        TIMESTAMPTZ,                           -- brute-force lockout
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT credits_non_negative CHECK (credits >= 0)
);

CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_stripe_customer ON users (stripe_customer_id);
CREATE INDEX idx_users_membership ON users (membership_type);

-- ----------------------------------------------------------------------------
-- REFRESH TOKENS (JWT access tokens are NOT stored — only refresh tokens,
-- so they can be revoked. Access tokens are short-lived and stateless.)
-- ----------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL,        -- SHA-256 of the token, never store raw
    device_info     VARCHAR(255),
    ip_address      INET,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens (token_hash);

-- ----------------------------------------------------------------------------
-- PASSWORD RESET TOKENS
-- ----------------------------------------------------------------------------
CREATE TABLE password_reset_tokens (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  VARCHAR(255) NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_user ON password_reset_tokens (user_id);

-- ----------------------------------------------------------------------------
-- SUBSCRIPTIONS — mirrors Stripe subscription state. Stripe is the source
-- of truth for billing; this table is a queryable local mirror kept in
-- sync via webhooks, so the app never calls Stripe synchronously on every
-- request just to check "is this user Pro."
-- ----------------------------------------------------------------------------
CREATE TYPE subscription_status AS ENUM (
    'active', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'unpaid'
);

CREATE TABLE subscriptions (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_subscription_id  VARCHAR(255) UNIQUE NOT NULL,
    stripe_price_id         VARCHAR(255) NOT NULL,
    status                  subscription_status NOT NULL,
    current_period_start    TIMESTAMPTZ NOT NULL,
    current_period_end      TIMESTAMPTZ NOT NULL,       -- "renewal_date" from the spec
    cancel_at_period_end    BOOLEAN NOT NULL DEFAULT FALSE,
    canceled_at             TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_subscriptions_user ON subscriptions (user_id);
CREATE INDEX idx_subscriptions_status ON subscriptions (status);
CREATE INDEX idx_subscriptions_period_end ON subscriptions (current_period_end);

-- ----------------------------------------------------------------------------
-- CREDIT PURCHASES — one row per completed Stripe one-time payment
-- ----------------------------------------------------------------------------
CREATE TABLE credit_purchases (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_payment_intent_id VARCHAR(255) UNIQUE NOT NULL,
    stripe_checkout_session_id VARCHAR(255),
    amount_paid_cents       INTEGER NOT NULL,           -- cents, e.g. 499 = $4.99
    credits_received        INTEGER NOT NULL,
    pack_id                 VARCHAR(50) NOT NULL,        -- e.g. 'pack_500', 'pack_10000'
    status                  VARCHAR(20) NOT NULL DEFAULT 'completed', -- completed | refunded
    purchase_date            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_credit_purchases_user ON credit_purchases (user_id);
CREATE INDEX idx_credit_purchases_date ON credit_purchases (purchase_date);

-- ----------------------------------------------------------------------------
-- CREDIT TRANSACTIONS — append-only ledger. THIS IS THE SOURCE OF TRUTH.
-- Every credit grant or deduction, for any reason, gets a row here.
-- users.credits is just a cached SUM() of this table for fast reads.
-- ----------------------------------------------------------------------------
CREATE TYPE credit_action AS ENUM (
    'signup_bonus',           -- not granted automatically (no free signup credits) — kept as a valid action type for optional future promotions
    'subscription_grant',     -- +500 on Pro renewal
    'purchase',                -- + credit pack
    'admin_adjustment',        -- manual correction by an admin
    'refund_clawback',         -- credits removed because a purchase was refunded
    'ai_coach_question',        -- -12
    'custom_training_plan',     -- -12
    'nutrition_plan',           -- -30
    'sparring_review',          -- -10
    'opponent_analysis',        -- -12
    'fight_camp_builder',       -- -18
    'food_search',              -- -1
    'food_photo_estimate'       -- -2
);

CREATE TABLE credit_transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action          credit_action NOT NULL,
    credits_delta   INTEGER NOT NULL,        -- positive = grant, negative = consumption
    balance_after   BIGINT NOT NULL,          -- snapshot of balance post-transaction, for audit/debugging
    reference_id    UUID,                     -- FK to ai_requests.id, credit_purchases.id, or subscriptions.id depending on action
    metadata        JSONB,                    -- free-form context (e.g. {"feature":"opponent_analysis","model":"claude-sonnet-4-6"})
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_credit_tx_user ON credit_transactions (user_id, created_at DESC);
CREATE INDEX idx_credit_tx_action ON credit_transactions (action);
-- Partitioning recommendation for scale is covered in the architecture doc.

-- ----------------------------------------------------------------------------
-- AI REQUESTS — one row per Anthropic API call. This is what powers cost
-- tracking, profit estimates, and the admin dashboard's API cost panel.
-- ----------------------------------------------------------------------------
CREATE TYPE ai_feature AS ENUM (
    'ai_coach_question', 'custom_training_plan', 'nutrition_plan',
    'sparring_review', 'opponent_analysis', 'fight_camp_builder',
    'food_search', 'food_photo_estimate'
);

CREATE TABLE ai_requests (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature             ai_feature NOT NULL,
    credits_charged     INTEGER NOT NULL,
    model               VARCHAR(100) NOT NULL,             -- e.g. 'claude-sonnet-4-6'
    input_tokens        INTEGER,
    output_tokens       INTEGER,
    estimated_cost_cents NUMERIC(10,4),                     -- Anthropic's actual cost to you, in cents (fractional cents tracked precisely)
    status              VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | success | failed | refunded
    error_message       TEXT,
    latency_ms          INTEGER,
    request_metadata    JSONB,                              -- sanitized request params (NEVER raw prompt content with PII by default)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_ai_requests_user ON ai_requests (user_id, created_at DESC);
CREATE INDEX idx_ai_requests_feature ON ai_requests (feature);
CREATE INDEX idx_ai_requests_status ON ai_requests (status);
CREATE INDEX idx_ai_requests_created ON ai_requests (created_at);

-- ----------------------------------------------------------------------------
-- STRIPE WEBHOOK EVENTS — idempotency log. Stripe will retry webhooks;
-- this table makes every webhook handler idempotent by construction.
-- ----------------------------------------------------------------------------
CREATE TABLE stripe_webhook_events (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stripe_event_id     VARCHAR(255) UNIQUE NOT NULL,
    event_type          VARCHAR(100) NOT NULL,
    processed_at        TIMESTAMPTZ,
    processing_error     TEXT,
    payload              JSONB NOT NULL,
    received_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_events_type ON stripe_webhook_events (event_type);
CREATE INDEX idx_webhook_events_processed ON stripe_webhook_events (processed_at);

-- ----------------------------------------------------------------------------
-- AUDIT LOG — admin actions (manual credit adjustments, role changes, etc.)
-- ----------------------------------------------------------------------------
CREATE TABLE admin_audit_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    admin_user_id   UUID NOT NULL REFERENCES users(id),
    action          VARCHAR(100) NOT NULL,
    target_user_id  UUID REFERENCES users(id),
    details         JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_admin ON admin_audit_log (admin_user_id);
CREATE INDEX idx_audit_log_target ON admin_audit_log (target_user_id);

-- ----------------------------------------------------------------------------
-- updated_at auto-touch trigger (applied to tables that have the column)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER trg_subscriptions_updated_at BEFORE UPDATE ON subscriptions
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
