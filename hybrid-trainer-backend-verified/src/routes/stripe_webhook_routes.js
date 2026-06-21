// ============================================================================
// STRIPE WEBHOOKS — this is where almost all real bugs in payment systems
// live. Three rules that this file enforces structurally, not just by
// convention:
//
//   1. ALWAYS verify the webhook signature. Without this, anyone who
//      finds your webhook URL can POST a fake "payment succeeded" event
//      and get free credits.
//   2. ALWAYS check stripe_webhook_events for the event id before doing
//      anything. Stripe retries webhooks on timeout/5xx, and retries
//      WILL arrive — if your handler isn't idempotent, a single payment
//      can grant credits twice.
//   3. Respond 200 OK quickly. Do the actual work, but if something is
//      slow (e.g. sending a welcome email), enqueue it rather than
//      blocking the webhook response — Stripe times out and retries
//      slow webhooks, compounding into the idempotency concern above.
// ============================================================================

const express = require('express');
const router = express.Router();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const pool = require('../db/pool');
const creditService = require('../credits/credit_service');
const { SUBSCRIPTION_TIERS } = require('../credits/pricing_config');

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// CRITICAL: this route must receive the RAW request body, not JSON-parsed.
// Stripe's signature is computed over the exact raw bytes; if Express's
// json() middleware has already parsed/re-serialized the body, signature
// verification will fail. Mount this with express.raw() specifically for
// this path, BEFORE any global express.json() middleware applies to it.
router.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook signature verification failed.`);
  }

  // RULE 2: idempotency check. Insert-or-detect-conflict on the unique
  // stripe_event_id. If this event was already processed, acknowledge
  // and exit — do not run the handler logic again.
  const insertResult = await pool.query(
    `INSERT INTO stripe_webhook_events (stripe_event_id, event_type, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING id`,
    [event.id, event.type, JSON.stringify(event.data.object)]
  );

  if (insertResult.rows.length === 0) {
    // Already processed (or currently being processed by a concurrent
    // delivery) — Stripe just wants a 200 so it stops retrying.
    return res.status(200).json({ received: true, deduped: true });
  }

  const webhookEventId = insertResult.rows[0].id;

  try {
    await handleEvent(event);
    await pool.query(`UPDATE stripe_webhook_events SET processed_at = now() WHERE id = $1`, [webhookEventId]);
    res.status(200).json({ received: true });
  } catch (err) {
    console.error(`Error processing webhook ${event.type} (${event.id}):`, err);
    await pool.query(
      `UPDATE stripe_webhook_events SET processing_error = $1 WHERE id = $2`,
      [String(err.message || err).slice(0, 2000), webhookEventId]
    );
    // Return 500 so Stripe retries — but because of the idempotency
    // table, IF the failure happened after partial work was done, you
    // need handleEvent's internal steps to also be safe to re-run.
    // (Each branch below uses ON CONFLICT / atomic SQL functions for
    // exactly this reason.)
    res.status(500).json({ error: 'Internal error processing webhook.' });
  }
});

async function handleEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed':
      return handleCheckoutCompleted(event.data.object);
    case 'invoice.payment_succeeded':
      return handleInvoicePaymentSucceeded(event.data.object);
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(event.data.object);
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(event.data.object);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event.data.object);
    case 'charge.refunded':
      return handleChargeRefunded(event.data.object);
    default:
      // Unhandled event types are fine to ignore — just don't silently
      // swallow ones you actually care about. Log unknowns so you notice
      // if Stripe adds an event type you should be handling.
      console.log(`Unhandled Stripe event type: ${event.type}`);
  }
}

// ----------------------------------------------------------------------------
// checkout.session.completed — fires for BOTH subscription checkouts and
// one-time credit pack checkouts. We branch on metadata.purchase_type,
// which we set ourselves when creating the session (see checkout.js).
// ----------------------------------------------------------------------------
async function handleCheckoutCompleted(session) {
  const userId = session.metadata.app_user_id;
  if (!userId) {
    throw new Error(`Checkout session ${session.id} missing app_user_id metadata.`);
  }

  if (session.metadata.purchase_type === 'credit_pack') {
    const credits = parseInt(session.metadata.credits, 10);
    const packId = session.metadata.pack_id;

    // ON CONFLICT on stripe_payment_intent_id inside grantPurchasedCredits'
    // INSERT makes this safe even if somehow called twice.
    await creditService.grantPurchasedCredits({
      userId,
      credits,
      packId,
      stripePaymentIntentId: session.payment_intent,
      amountPaidCents: session.amount_total,
    });
  }

  // Subscription checkouts are fully handled by invoice.payment_succeeded
  // (fired immediately after checkout for the first invoice, and again
  // every renewal) — we don't need to do anything subscription-specific
  // here, since that event carries the subscription id we need.
}

// ----------------------------------------------------------------------------
// invoice.payment_succeeded — fires on EVERY successful charge for a
// subscription: the initial one AND every monthly renewal. This is the
// correct place to grant the monthly 500 credits, not checkout.session.completed,
// because renewals don't go through Checkout again.
// ----------------------------------------------------------------------------
async function handleInvoicePaymentSucceeded(invoice) {
  if (!invoice.subscription) return; // not a subscription invoice

  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
  const userId = subscription.metadata.app_user_id;
  if (!userId) {
    throw new Error(`Subscription ${subscription.id} missing app_user_id metadata.`);
  }

  const stripePriceId = subscription.items.data[0].price.id;
  // Determine which named tier this price corresponds to, so
  // membership_type reflects Fighter/Competitor specifically rather
  // than a generic 'pro' — the app needs the real tier name to decide
  // which features to unlock and what allowance limits apply.
  const tierEntry = Object.entries(SUBSCRIPTION_TIERS).find(([, t]) => t.stripePriceId === stripePriceId);
  if (!tierEntry) {
    throw new Error(`Subscription price ${stripePriceId} doesn't match any known SUBSCRIPTION_TIERS entry — check STRIPE_PRICE_FIGHTER_MONTHLY / STRIPE_PRICE_COMPETITOR_MONTHLY env vars.`);
  }
  const [tierId] = tierEntry;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO subscriptions (user_id, stripe_subscription_id, stripe_price_id, status, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET
         status = EXCLUDED.status,
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         updated_at = now()`,
      [
        userId, subscription.id, stripePriceId, subscription.status,
        new Date(subscription.current_period_start * 1000),
        new Date(subscription.current_period_end * 1000),
      ]
    );

    await client.query(`UPDATE users SET membership_type = $1::membership_type WHERE id = $2`, [tierId, userId]);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // No credit grant here — subscriptions unlock a monthly feature
  // ALLOWANCE (tracked in subscription_allowance_usage, reset
  // automatically each period since usage rows are keyed by
  // period_start), not Training Credits. See credit_service.js's
  // tryUseSubscriptionAllowance for how that allowance gets consumed.
}

// ----------------------------------------------------------------------------
// invoice.payment_failed — card declined, expired, insufficient funds.
// Stripe will retry per your configured retry schedule (Smart Retries).
// We just reflect status; Stripe handles dunning emails if enabled.
// ----------------------------------------------------------------------------
async function handleInvoicePaymentFailed(invoice) {
  if (!invoice.subscription) return;
  await pool.query(
    `UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE stripe_subscription_id = $1`,
    [invoice.subscription]
  );
  // TODO: enqueue "your payment failed" email. Do NOT downgrade
  // membership_type yet — Stripe's retry schedule may still succeed.
  // Final downgrade happens on customer.subscription.deleted below.
}

// ----------------------------------------------------------------------------
// customer.subscription.updated — covers plan changes, cancel_at_period_end
// being set/unset, and status transitions.
// ----------------------------------------------------------------------------
async function handleSubscriptionUpdated(subscription) {
  await pool.query(
    `UPDATE subscriptions
     SET status = $1, current_period_end = $2, cancel_at_period_end = $3, updated_at = now()
     WHERE stripe_subscription_id = $4`,
    [
      subscription.status,
      new Date(subscription.current_period_end * 1000),
      subscription.cancel_at_period_end,
      subscription.id,
    ]
  );
}

// ----------------------------------------------------------------------------
// customer.subscription.deleted — the subscription is actually over
// (either canceled immediately, or cancel_at_period_end finally arrived).
// Downgrade membership. No allowance cleanup needed — usage rows are
// historical records keyed by period_start, not something to claw back.
// ----------------------------------------------------------------------------
async function handleSubscriptionDeleted(subscription) {
  const userId = subscription.metadata.app_user_id;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = now(), updated_at = now() WHERE stripe_subscription_id = $1`,
      [subscription.id]
    );
    await client.query(`UPDATE users SET membership_type = 'free' WHERE id = $1`, [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------------
// charge.refunded — claw back credits if a credit-pack purchase is
// refunded (e.g. via a chargeback or manual refund in the Stripe
// dashboard). Subscription refunds are rare and usually handled
// manually/case-by-case, so this focuses on one-time credit packs.
// ----------------------------------------------------------------------------
async function handleChargeRefunded(charge) {
  const purchaseResult = await pool.query(
    `SELECT id, user_id, credits_received FROM credit_purchases WHERE stripe_payment_intent_id = $1 AND status = 'completed'`,
    [charge.payment_intent]
  );
  const purchase = purchaseResult.rows[0];
  if (!purchase) return; // not a tracked credit-pack purchase, or already clawed back

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE credit_purchases SET status = 'refunded' WHERE id = $1`, [purchase.id]);
    // Claw back via the same atomic deduct function — if the user already
    // spent the credits and their balance is now insufficient, this will
    // fail gracefully (success=false) rather than driving the balance
    // negative. That's a deliberate business decision: flag it for
    // manual admin review rather than silently going negative.
    const deductResult = await client.query(
      `SELECT * FROM deduct_credits($1, $2, 'refund_clawback', $3, $4)`,
      [purchase.user_id, purchase.credits_received, purchase.id, JSON.stringify({ reason: 'charge_refunded' })]
    );
    if (!deductResult.rows[0].success) {
      console.warn(`Refund clawback for purchase ${purchase.id} could not complete — user balance too low. Flagging for admin review.`);
      await client.query(
        `INSERT INTO admin_audit_log (admin_user_id, action, target_user_id, details)
         SELECT id, 'refund_clawback_failed', $1, $2 FROM users WHERE membership_type = 'admin' LIMIT 1`,
        [purchase.user_id, JSON.stringify({ purchaseId: purchase.id, creditsOwed: purchase.credits_received })]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = router;
