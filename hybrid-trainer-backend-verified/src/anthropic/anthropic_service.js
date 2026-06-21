// ============================================================================
// ANTHROPIC API SERVICE — server-side only. The API key NEVER reaches the
// client in any form. Every AI feature in the app funnels through
// `runAiRequest` below, which implements the exact flow from the spec:
//   1. Check balance  2. Verify sufficient credits  3. Deduct credits
//   4. Save transaction record  5. Call Anthropic  6. Return response
//   7. Log token usage  8. Log API cost
//
// Calls Anthropic's REST API directly via fetch() rather than the
// @anthropic-ai/sdk package — every request failed with "Premature
// close" when going through the SDK (confirmed not an account/key/
// balance issue via a successful direct Workbench test), and the SDK
// does its own response-stream handling on top of the raw HTTP layer,
// which is a plausible source of exactly this symptom on an older
// pinned version. A plain fetch() removes that layer entirely.
// ============================================================================

const pool = require('../db/pool');
const creditService = require('../credits/credit_service');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

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
  // STEP 1 + 2 + 3: check subscription allowance first, fall back to
  // credits — all atomic in one SQL call either way. Throws
  // InsufficientCreditsError if neither covers it, in which case we
  // never reach the Anthropic call at all.
  const charge = await creditService.chargeForFeature({ userId, feature });
  const { transactionId, cost } = charge;

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

  // Anthropic calls occasionally fail with a transient network error
  // (e.g. "Premature close" — the connection between Render and
  // Anthropic's API drops mid-response before any data is corrupted,
  // not a real failure of the request itself). One automatic retry
  // catches these without making the user manually resend.
  const MAX_ATTEMPTS = 2;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // STEP 5: the actual Anthropic call — direct fetch(), not the SDK
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(anthropicParams),
      });

      if (!apiRes.ok) {
        const errBody = await apiRes.text().catch(() => '');
        throw new Error(`Anthropic API returned ${apiRes.status}: ${errBody.slice(0, 500)}`);
      }

      const response = await apiRes.json();

      const latencyMs = Date.now() - startTime;
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const costCents = estimateCostCents(anthropicParams.model, inputTokens, outputTokens);

      await pool.query(
        `UPDATE ai_requests
         SET status = 'success', input_tokens = $1, output_tokens = $2,
             estimated_cost_cents = $3, latency_ms = $4, completed_at = now()
         WHERE id = $5`,
        [inputTokens, outputTokens, costCents, latencyMs, aiRequestId]
      );

      return { response, aiRequestId, creditsCharged: cost, viaSubscription: charge.viaSubscription || false,
        allowanceUsed: charge.allowanceUsed, allowanceLimit: charge.allowanceLimit, tierLabel: charge.tierLabel };

    } catch (err) {
      lastErr = err;
      // THIS is the line that was missing all along — every failure
      // tonight was being silently swallowed into the database with
      // no trace in Render's console output at all, which is why the
      // Logs tab kept showing nothing during live troubleshooting.
      console.error(`[runAiRequest] Attempt ${attempt}/${MAX_ATTEMPTS} failed for feature=${feature}, user=${userId}:`, err.message || err);

      const isTransient = /premature close|ECONNRESET|socket hang up|ETIMEDOUT/i.test(String(err.message || err));
      if (isTransient && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 500)); // brief pause before retry
        continue;
      }
      break; // either not transient, or out of attempts — fall through to the failure handling below
    }
  }

  // All attempts exhausted
  const latencyMs = Date.now() - startTime;
  await pool.query(
    `UPDATE ai_requests
     SET status = 'failed', error_message = $1, latency_ms = $2, completed_at = now()
     WHERE id = $3`,
    [String(lastErr.message || lastErr).slice(0, 1000), latencyMs, aiRequestId]
  );

  await creditService.refundFailedRequest({
    userId, cost, originalTransactionId: transactionId, reason: lastErr.message,
  });

  const refundNote = cost > 0 ? ' Your credits have been refunded.' : '';
  throw new AiRequestError(`The AI coach is temporarily unavailable.${refundNote} Please try again.`, lastErr);
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
