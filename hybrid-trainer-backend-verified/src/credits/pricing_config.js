// ============================================================================
// PRICING CONFIG — single source of truth for credit costs and packs.
// Import this everywhere rather than hardcoding numbers, so changing a
// price is a one-line edit instead of a grep-and-pray across the codebase.
// ============================================================================

// ============================================================================
// FEATURE COSTS — derived from real measured Anthropic API costs per
// feature (system prompt size, image token cost for vision features,
// typical output length against each call's max_tokens), priced at
// roughly 2.7-3.4x real cost even at the WORST-CASE pack tier (the
// $49.99/10,000-credit Elite Pack, which has the lowest $-per-credit
// rate of any pack). This margin covers Anthropic's actual per-call
// cost, Stripe's processing fee (~3%), and hosting — not just
// breakeven. Recalculate these whenever Anthropic's published per-token
// rates change, or if a system prompt/max_tokens value changes
// meaningfully in the app code, since both directly change real cost.
// ============================================================================

const FEATURE_COSTS = {
  ai_coach_question:     12,  // claude-sonnet-4-6, ~3.8k input incl. system prompt + history, ~700 output
  custom_training_plan:  12,  // same call shape as ai_coach_question
  nutrition_plan:        30,  // claude-sonnet-4-6, full 7-day plan generation, ~3.2k output tokens (largest single output in the app)
  sparring_review:       10,  // claude-sonnet-4-6, 6 video frames + analysis
  opponent_analysis:     12,  // claude-sonnet-4-6, 8 video frames + analysis
  fight_camp_builder:    18,  // claude-sonnet-4-6, longer-form multi-week plan output
  food_search:           1,   // claude-haiku-4-5, short text-based nutrition lookup — cheapest call in the app
  food_photo_estimate:   2,   // claude-sonnet-4-6, single image + small JSON output
};

// No free credits on signup, by design — new users see their real 0
// balance immediately and are prompted to purchase before using any AI
// feature. Kept as a named constant (rather than removed outright) in
// case you want to run a future promotional bonus — change this value
// and reintroduce the grant_credits call in auth_service.js if so.
const SIGNUP_BONUS_CREDITS = 0;

const CREDIT_PACKS = {
  pack_500:   { credits: 500,   priceCents: 499,  stripePriceId: process.env.STRIPE_PRICE_PACK_500 },
  pack_1200:  { credits: 1200,  priceCents: 999,  stripePriceId: process.env.STRIPE_PRICE_PACK_1200 },
  pack_3000:  { credits: 3000,  priceCents: 1999, stripePriceId: process.env.STRIPE_PRICE_PACK_3000 },
  pack_10000: { credits: 10000, priceCents: 4999, stripePriceId: process.env.STRIPE_PRICE_PACK_10000 },
};

// ============================================================================
// SUBSCRIPTION TIERS — Fighter and Competitor. These do NOT grant
// Training Credits — they unlock a bundled MONTHLY ALLOWANCE of
// specific AI features, on top of (not instead of) the credit system.
// A subscriber who exhausts their monthly allowance falls back to
// paying Training Credits for additional usage, same as a free user.
//
// `allowances` keys must match FEATURE_COSTS keys exactly — the
// allowance-checking code looks features up by this shared key.
// ============================================================================
const SUBSCRIPTION_TIERS = {
  fighter: {
    label: 'Fighter',
    priceCents: 1999,
    stripePriceId: process.env.STRIPE_PRICE_FIGHTER_MONTHLY,
    allowances: {
      ai_coach_question: 40,
      custom_training_plan: 2,
      fight_camp_builder: 1,
    },
  },
  competitor: {
    label: 'Competitor',
    priceCents: 2999,
    stripePriceId: process.env.STRIPE_PRICE_COMPETITOR_MONTHLY,
    allowances: {
      ai_coach_question: 80,
      custom_training_plan: 2,       // inherited from Fighter
      fight_camp_builder: 1,          // inherited from Fighter
      sparring_review: 4,
      opponent_analysis: 3,
      nutrition_plan: 2,
    },
  },
};

module.exports = {
  FEATURE_COSTS, SIGNUP_BONUS_CREDITS,
  CREDIT_PACKS, SUBSCRIPTION_TIERS,
};
