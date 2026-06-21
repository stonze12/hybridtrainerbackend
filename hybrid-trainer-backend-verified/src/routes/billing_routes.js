// ============================================================================
// BILLING ROUTES — thin Express wrappers around the Stripe service
// functions in stripe/checkout.js. These are the endpoints the mobile
// app's Store page calls.
// ============================================================================

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/middleware');
const pool = require('../db/pool');
const { createSubscriptionCheckout, createCreditPackCheckout, createBillingPortalSession } = require('../stripe/checkout');
const { CREDIT_PACKS, SUBSCRIPTION_TIERS } = require('../credits/pricing_config');

async function getUser(userId) {
  const result = await pool.query(
    `SELECT id, email, username, membership_type, credits, stripe_customer_id FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0];
}

// APP_URL is the base URL of your client app — used to build the
// success/cancel redirect targets Stripe Checkout sends the user back to.
// For a web client this is your site origin; for a mobile app, this is
// typically a universal link / deep link scheme (e.g. hybridtrainer://billing).
const APP_URL = process.env.APP_URL || 'http://localhost:3000';

router.post('/api/billing/checkout/subscription', requireAuth, async (req, res, next) => {
  const { tier } = req.body;
  if (!SUBSCRIPTION_TIERS[tier]) {
    return res.status(400).json({ error: 'Unknown subscription tier.', validTiers: Object.keys(SUBSCRIPTION_TIERS) });
  }
  try {
    const user = await getUser(req.user.id);
    const url = await createSubscriptionCheckout({
      user, tierId: tier,
      successUrl: `${APP_URL}/billing/success?type=subscription&tier=${tier}`,
      cancelUrl: `${APP_URL}/billing/cancel`,
    });
    res.json({ checkoutUrl: url });
  } catch (err) { next(err); }
});

router.post('/api/billing/checkout/credits', requireAuth, async (req, res, next) => {
  const { packId } = req.body;
  if (!CREDIT_PACKS[packId]) {
    return res.status(400).json({ error: 'Unknown credit pack id.', validPacks: Object.keys(CREDIT_PACKS) });
  }
  try {
    const user = await getUser(req.user.id);
    const url = await createCreditPackCheckout({
      user, packId,
      successUrl: `${APP_URL}/billing/success?type=credits`,
      cancelUrl: `${APP_URL}/billing/cancel`,
    });
    res.json({ checkoutUrl: url });
  } catch (err) { next(err); }
});

router.post('/api/billing/portal', requireAuth, async (req, res, next) => {
  try {
    const user = await getUser(req.user.id);
    const url = await createBillingPortalSession({ user, returnUrl: `${APP_URL}/account` });
    res.json({ portalUrl: url });
  } catch (err) {
    if (err.message.includes('no Stripe customer record')) {
      return res.status(400).json({ error: 'No billing history yet — make a purchase first.' });
    }
    next(err);
  }
});

// Returns the user's active subscription (if any) plus this billing
// period's allowance usage per feature — what the Profile/Store
// screens display as "Fighter · 23/40 Coach questions used".
router.get('/api/billing/subscription', requireAuth, async (req, res, next) => {
  try {
    const subResult = await pool.query(
      `SELECT id, stripe_price_id, status, current_period_start, current_period_end, cancel_at_period_end
       FROM subscriptions
       WHERE user_id = $1 AND status = 'active' AND current_period_end > now()
       ORDER BY current_period_end DESC LIMIT 1`,
      [req.user.id]
    );
    const sub = subResult.rows[0];
    if (!sub) return res.json({ subscription: null });

    const tierEntry = Object.entries(SUBSCRIPTION_TIERS).find(([, t]) => t.stripePriceId === sub.stripe_price_id);
    if (!tierEntry) return res.json({ subscription: null }); // price doesn't match a known tier (e.g. old/removed tier)
    const [tierId, tier] = tierEntry;

    const usageResult = await pool.query(
      `SELECT ai_coach_question_used, custom_training_plan_used, fight_camp_builder_used,
              sparring_review_used, opponent_analysis_used, nutrition_plan_used
       FROM subscription_allowance_usage
       WHERE user_id = $1 AND period_start = $2`,
      [req.user.id, sub.current_period_start]
    );
    const usage = usageResult.rows[0] || {
      ai_coach_question_used: 0, custom_training_plan_used: 0, fight_camp_builder_used: 0,
      sparring_review_used: 0, opponent_analysis_used: 0, nutrition_plan_used: 0,
    };

    const allowances = Object.entries(tier.allowances).map(([feature, limit]) => ({
      feature, limit, used: usage[`${feature}_used`] || 0,
    }));

    res.json({
      subscription: {
        tierId, tierLabel: tier.label,
        currentPeriodEnd: sub.current_period_end,
        cancelAtPeriodEnd: sub.cancel_at_period_end,
        allowances,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
