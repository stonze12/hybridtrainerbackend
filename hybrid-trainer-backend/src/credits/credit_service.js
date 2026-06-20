// ============================================================================
// CREDIT SERVICE — thin wrapper around the atomic SQL functions
// (deduct_credits / grant_credits in credit_functions.sql). All credit
// movement in the app goes through this file. Nothing else should ever
// run `UPDATE users SET credits = ...` directly.
// ============================================================================

const pool = require('../db/pool');
const { FEATURE_COSTS } = require('./pricing_config');

class InsufficientCreditsError extends Error {
  constructor(required, available) {
    super(`Insufficient credits: need ${required}, have ${available}.`);
    this.name = 'InsufficientCreditsError';
    this.statusCode = 402; // Payment Required — the correct HTTP status for this
    this.required = required;
    this.available = available;
  }
}

/**
 * Charges a user for an AI feature. Call this BEFORE making the Anthropic
 * API call. If it throws InsufficientCreditsError, do not call Anthropic.
 *
 * Returns the transaction id, which the caller should pass back into
 * recordAiRequestCompletion / refundOnFailure so the ledger entries link
 * to the actual ai_requests row.
 */
async function chargeForFeature({ userId, feature }) {
  const cost = FEATURE_COSTS[feature];
  if (cost === undefined) throw new Error(`Unknown feature: ${feature}`);

  const result = await pool.query(
    `SELECT * FROM deduct_credits($1, $2, $3::credit_action, NULL, $4)`,
    [userId, cost, feature, JSON.stringify({ feature })]
  );

  const { success, new_balance, transaction_id } = result.rows[0];

  if (!success) {
    const balanceResult = await pool.query(`SELECT credits FROM users WHERE id = $1`, [userId]);
    const available = balanceResult.rows[0]?.credits ?? 0;
    throw new InsufficientCreditsError(cost, available);
  }

  return { transactionId: transaction_id, newBalance: new_balance, cost };
}

/**
 * If the Anthropic call fails AFTER credits were already deducted (e.g.
 * the API times out, returns a 500, or the request is invalid in a way
 * we couldn't detect before sending), refund the credits. This keeps
 * the "deduct before calling" pattern (which prevents a race where two
 * fast double-clicks both pass a balance check before either deducts)
 * from ever charging a user for a request that didn't actually run.
 */
async function refundFailedRequest({ userId, cost, originalTransactionId, reason }) {
  await pool.query(
    `SELECT * FROM grant_credits($1, $2, 'admin_adjustment', $3, $4)`,
    [userId, cost, originalTransactionId, JSON.stringify({ reason: 'ai_request_failed', detail: reason })]
  );
}

async function getBalance(userId) {
  const result = await pool.query(`SELECT credits FROM users WHERE id = $1`, [userId]);
  if (!result.rows[0]) throw new Error('User not found');
  return result.rows[0].credits;
}

async function grantPurchasedCredits({ userId, credits, packId, stripePaymentIntentId, amountPaidCents }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const purchaseResult = await client.query(
      `INSERT INTO credit_purchases (user_id, stripe_payment_intent_id, amount_paid_cents, credits_received, pack_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [userId, stripePaymentIntentId, amountPaidCents, credits, packId]
    );
    const purchaseId = purchaseResult.rows[0].id;

    await client.query(
      `SELECT * FROM grant_credits($1, $2, 'purchase', $3, $4)`,
      [userId, credits, purchaseId, JSON.stringify({ packId, amountPaidCents })]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function grantMonthlyProCredits({ userId, subscriptionId, credits }) {
  // Idempotency note: this is called from the Stripe webhook handler on
  // `invoice.payment_succeeded`. Stripe can deliver the same webhook event
  // more than once — the webhook handler itself dedupes via
  // stripe_webhook_events (see stripe_webhooks.js), so by the time this
  // function runs we know it's a genuinely new billing cycle, not a retry.
  await pool.query(
    `SELECT * FROM grant_credits($1, $2, 'subscription_grant', $3, $4)`,
    [userId, credits, subscriptionId, JSON.stringify({ subscriptionId })]
  );
}

module.exports = {
  chargeForFeature, refundFailedRequest, getBalance,
  grantPurchasedCredits, grantMonthlyProCredits,
  InsufficientCreditsError,
};
