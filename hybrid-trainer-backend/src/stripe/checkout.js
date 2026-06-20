// ============================================================================
// STRIPE CHECKOUT — creates Checkout Sessions for both the Pro subscription
// and one-time credit pack purchases. Using Stripe Checkout (hosted page)
// rather than building a custom card form means PCI scope stays minimal —
// card data never touches your servers.
// ============================================================================

const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const pool = require('../db/pool');
const { CREDIT_PACKS, STRIPE_PRICE_PRO_MONTHLY } = require('../credits/pricing_config');

/**
 * Ensures the user has a Stripe Customer object, creating one on first
 * use. Storing stripe_customer_id means you never create duplicate
 * Stripe customers for the same user across multiple purchases.
 */
async function getOrCreateStripeCustomer(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { app_user_id: user.id }, // critical: lets webhooks map Stripe events back to your user
  });

  await pool.query(`UPDATE users SET stripe_customer_id = $1 WHERE id = $2`, [customer.id, user.id]);
  return customer.id;
}

/**
 * Creates a Checkout Session for the Pro monthly subscription.
 */
async function createSubscriptionCheckout({ user, successUrl, cancelUrl }) {
  const customerId = await getOrCreateStripeCustomer(user);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: STRIPE_PRICE_PRO_MONTHLY, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { app_user_id: user.id, purchase_type: 'subscription' },
    subscription_data: {
      metadata: { app_user_id: user.id },
    },
    // Lets returning customers reuse a saved card; new customers enter
    // card details on Stripe's hosted page.
    payment_method_collection: 'always',
  });

  return session.url;
}

/**
 * Creates a Checkout Session for a one-time credit pack purchase.
 */
async function createCreditPackCheckout({ user, packId, successUrl, cancelUrl }) {
  const pack = CREDIT_PACKS[packId];
  if (!pack) throw new Error(`Unknown credit pack: ${packId}`);

  const customerId = await getOrCreateStripeCustomer(user);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'payment',
    line_items: [{ price: pack.stripePriceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      app_user_id: user.id,
      purchase_type: 'credit_pack',
      pack_id: packId,
      credits: String(pack.credits),
    },
  });

  return session.url;
}

/**
 * Creates a Stripe Billing Portal session so users can manage/cancel
 * their own subscription without you building custom UI for it.
 */
async function createBillingPortalSession({ user, returnUrl }) {
  if (!user.stripe_customer_id) {
    throw new Error('User has no Stripe customer record — they have never purchased anything.');
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: user.stripe_customer_id,
    return_url: returnUrl,
  });
  return session.url;
}

module.exports = { createSubscriptionCheckout, createCreditPackCheckout, createBillingPortalSession, getOrCreateStripeCustomer };
