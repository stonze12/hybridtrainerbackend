// ============================================================================
// CREDIT SERVICE — thin wrapper around the atomic SQL functions
// (deduct_credits / grant_credits in credit_functions.sql). All credit
// movement in the app goes through this file. Nothing else should ever
// run `UPDATE users SET credits = ...` directly.
// ============================================================================

const pool = require('../db/pool');
const { FEATURE_COSTS, SUBSCRIPTION_TIERS } = require('./pricing_config');

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
 * Checks whether the user has an active subscription that bundles this
 * feature, and if so, atomically consumes one unit of that month's
 * allowance via use_allowance() (same atomic-row-update pattern as
 * deduct_credits — prevents two simultaneous requests both reading
 * "1 remaining" and both proceeding). Returns null if the user has no
 * active subscription, or the subscription's tier doesn't bundle this
 * feature at all (so the caller falls through to Training Credits).
 */
async function tryUseSubscriptionAllowance({ userId, feature }) {
  const subResult = await pool.query(
    `SELECT id, stripe_price_id, current_period_start, current_period_end
     FROM subscriptions
     WHERE user_id = $1 AND status = 'active' AND current_period_end > now()
     ORDER BY current_period_end DESC LIMIT 1`,
    [userId]
  );
  const sub = subResult.rows[0];
  if (!sub) return null; // no active subscription — fall back to credits

  // Match the subscription's Stripe Price ID back to a named tier, so
  // we know which allowance table applies.
  const tier = Object.values(SUBSCRIPTION_TIERS).find(t => t.stripePriceId === sub.stripe_price_id);
  if (!tier || tier.allowances[feature] === undefined) return null; // this tier doesn't bundle this feature

  const result = await pool.query(
    `SELECT * FROM use_allowance($1, $2, $3, $4, $5, $6)`,
    [userId, sub.id, sub.current_period_start, sub.current_period_end, feature, tier.allowances[feature]]
  );
  const { success, used_after } = result.rows[0];
  return { success, usedAfter: used_after, limit: tier.allowances[feature], tierLabel: tier.label };
}

/**
 * Charges a user for an AI feature. Call this BEFORE making the Anthropic
 * API call. If it throws InsufficientCreditsError, do not call Anthropic.
 *
 * Checks subscription allowance FIRST — if the user has an active
 * subscription that bundles this feature and hasn't exhausted this
 * month's allowance, the request is "charged" against that allowance
 * (free to the user) instead of Training Credits. Only falls back to
 * spending credits if there's no applicable subscription, or its
 * allowance for this feature is already used up this period.
 *
 * Returns the transaction id, which the caller should pass back into
 * recordAiRequestCompletion / refundOnFailure so the ledger entries link
 * to the actual ai_requests row.
 */
async function chargeForFeature({ userId, feature }) {
  const cost = FEATURE_COSTS[feature];
  if (cost === undefined) throw new Error(`Unknown feature: ${feature}`);

  const allowanceResult = await tryUseSubscriptionAllowance({ userId, feature });
  if (allowanceResult && allowanceResult.success) {
    // Covered by subscription allowance — no credits spent. transactionId
    // is null here since there's no credit_transactions row for this
    // charge; refundFailedRequest below handles both cases correctly.
    return { transactionId: null, newBalance: null, cost: 0, viaSubscription: true,
      allowanceUsed: allowanceResult.usedAfter, allowanceLimit: allowanceResult.limit, tierLabel: allowanceResult.tierLabel };
  }

  // No active subscription covering this feature, or allowance exhausted
  // this period — fall back to Training Credits, same as a free user.
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

  return { transactionId: transaction_id, newBalance: new_balance, cost, viaSubscription: false };
}

/**
 * If the Anthropic call fails AFTER credits were already deducted (e.g.
 * the API times out, returns a 500, or the request is invalid in a way
 * we couldn't detect before sending), refund the credits. This keeps
 * the "deduct before calling" pattern (which prevents a race where two
 * fast double-clicks both pass a balance check before either deducts)
 * from ever charging a user for a request that didn't actually run.
 *
 * Requests covered by subscription allowance (cost === 0, no
 * transactionId) have nothing to refund here — the failed allowance
 * unit isn't reclaimed, which is an intentional, acceptable tradeoff:
 * allowance "spend" on a failed request is a rare edge case, and
 * reclaiming it would need its own atomic decrement function for a
 * cost not worth the complexity at this scale.
 */
async function refundFailedRequest({ userId, cost, originalTransactionId, reason }) {
  if (!cost || cost === 0) return; // covered by subscription allowance — nothing to refund
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

module.exports = {
  chargeForFeature, refundFailedRequest, getBalance,
  grantPurchasedCredits, tryUseSubscriptionAllowance,
  InsufficientCreditsError,
};
