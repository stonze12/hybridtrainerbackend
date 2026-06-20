// ============================================================================
// PRICING CONFIG — single source of truth for credit costs and packs.
// Import this everywhere rather than hardcoding numbers, so changing a
// price is a one-line edit instead of a grep-and-pray across the codebase.
// ============================================================================

const FEATURE_COSTS = {
  ai_coach_question:     5,
  custom_training_plan:  15,
  nutrition_plan:        10,
  sparring_review:       20,
  opponent_analysis:     25,
  fight_camp_builder:    30,
};

const SIGNUP_BONUS_CREDITS = 25;
const PRO_MONTHLY_CREDITS = 500;

const CREDIT_PACKS = {
  pack_500:   { credits: 500,   priceCents: 499,  stripePriceId: process.env.STRIPE_PRICE_PACK_500 },
  pack_1200:  { credits: 1200,  priceCents: 999,  stripePriceId: process.env.STRIPE_PRICE_PACK_1200 },
  pack_3000:  { credits: 3000,  priceCents: 1999, stripePriceId: process.env.STRIPE_PRICE_PACK_3000 },
  pack_10000: { credits: 10000, priceCents: 4999, stripePriceId: process.env.STRIPE_PRICE_PACK_10000 },
};

const PRO_MONTHLY_PRICE_CENTS = 1499;
const STRIPE_PRICE_PRO_MONTHLY = process.env.STRIPE_PRICE_PRO_MONTHLY;

module.exports = {
  FEATURE_COSTS, SIGNUP_BONUS_CREDITS, PRO_MONTHLY_CREDITS,
  CREDIT_PACKS, PRO_MONTHLY_PRICE_CENTS, STRIPE_PRICE_PRO_MONTHLY,
};
