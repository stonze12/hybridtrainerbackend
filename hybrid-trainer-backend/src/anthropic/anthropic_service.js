// ============================================================================
// ANTHROPIC API SERVICE — server-side only. The API key NEVER reaches the
// client in any form. Every AI feature in the app funnels through
// `runAiRequest` below, which implements the exact flow from the spec:
//   1. Check balance  2. Verify sufficient credits  3. Deduct credits
//   4. Save transaction record  5. Call Anthropic  6. Return response
//   7. Log token usage  8. Log API cost
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db/pool');
const creditService = require('../credits/credit_service');

// API key lives in a secrets manager in production, injected as an env
// var at deploy time (e.g. AWS ECS task definition pulling from Secrets
// Manager, or Vault agent sidecar) — never in source control, never in
// a .env file that gets committed.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Pricing as of the model's published rate card — these are YOUR cost,
// not what you charge the user. Keep updated; consider fetching from a
// config service rather than hardcoding if you support multiple models.
// Figures here are illustrative placeholders — pull current rates from
// Anthropic's pricing page before relying on this for real cost tracking.
const MODEL_COST_PER_MTOK = {
  'claude-sonnet-4-6': { input: 300, output: 1500 },  // cents per million tokens
  'claude-haiku-4-5-20251001': { input: 80, output: 400 },
};

function estimateCostCents(model, inputTokens, outputTokens) {
  const rates = MODEL_COST_PER_MTOK[model];
  if (!rates) return null;
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
}

/**
 * The single entry point every AI-powered route calls. Wraps the entire
 * credit-check -> charge -> call -> log flow so individual route handlers
 * (coach.js, opponentAnalysis.js, etc.) stay thin and can't accidentally
 * skip a step.
 *
 * @param {string} userId
 * @param {string} feature - one of the ai_feature enum values
 * @param {object} anthropicParams - { model, max_tokens, system, messages, tools? }
 */
async function runAiRequest({ userId, feature, anthropicParams }) {
  // STEP 1 + 2 + 3: check balance, verify, deduct — all atomic in one
  // SQL call. Throws InsufficientCreditsError if the balance is too low,
  // in which case we never reach the Anthropic call at all.
  const { transactionId, cost } = await creditService.chargeForFeature({ userId, feature });

  // STEP 4: create the ai_requests row up front, status='pending'. This
  // means even if the process crashes mid-request, you have a record
  // that a charge happened and can reconcile/refund it later via a
  // sweep job rather than losing the event entirely.
  const requestRow = await pool.query(
    `INSERT INTO ai_requests (user_id, feature, credits_charged, model, status)
     VALUES ($1, $2, $3, $4, 'pending')
     RETURNING id`,
    [userId, feature, cost, anthropicParams.model]
  );
  const aiRequestId = requestRow.rows[0].id;

  const startTime = Date.now();

  try {
    // STEP 5: the actual Anthropic call
    const response = await anthropic.messages.create(anthropicParams);

    const latencyMs = Date.now() - startTime;
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costCents = estimateCostCents(anthropicParams.model, inputTokens, outputTokens);

    // STEP 7 + 8: log token usage and cost on the same row we created
    // in step 4 — update rather than insert, so there's exactly one row
    // per logical request regardless of success/failure.
    await pool.query(
      `UPDATE ai_requests
       SET status = 'success', input_tokens = $1, output_tokens = $2,
           estimated_cost_cents = $3, latency_ms = $4, completed_at = now()
       WHERE id = $5`,
      [inputTokens, outputTokens, costCents, latencyMs, aiRequestId]
    );

    // STEP 6: return response to caller
    return { response, aiRequestId, creditsCharged: cost };

  } catch (err) {
    const latencyMs = Date.now() - startTime;

    await pool.query(
      `UPDATE ai_requests
       SET status = 'failed', error_message = $1, latency_ms = $2, completed_at = now()
       WHERE id = $3`,
      [String(err.message || err).slice(0, 1000), latencyMs, aiRequestId]
    );

    // Refund the credits — the user shouldn't pay for a request that
    // never produced a result. This is why we deduct BEFORE calling
    // Anthropic rather than after: deduct-before with refund-on-failure
    // closes the race-condition window described in credit_functions.sql,
    // whereas deduct-after would reopen it.
    await creditService.refundFailedRequest({
      userId, cost, originalTransactionId: transactionId, reason: err.message,
    });

    // Re-throw so the route handler can return an appropriate error to
    // the client — but the user's credits are already safe at this point.
    throw new AiRequestError('The AI coach is temporarily unavailable. Your credits have been refunded — please try again.', err);
  }
}

class AiRequestError extends Error {
  constructor(userMessage, cause) {
    super(userMessage);
    this.name = 'AiRequestError';
    this.statusCode = 502;
    this.cause = cause;
  }
}

module.exports = { runAiRequest, AiRequestError, estimateCostCents };
