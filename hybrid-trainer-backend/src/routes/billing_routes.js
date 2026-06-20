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
const { CREDIT_PACKS } = require('../credits/pricing_config');

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
  try {
    const user = await getUser(req.user.id);
    const url = await createSubscriptionCheckout({
      user,
      successUrl: `${APP_URL}/billing/success?type=subscription`,
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

module.exports = router;
