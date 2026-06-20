// ============================================================================
// EXAMPLE ROUTE — AI Coach Question
// Shows the full pattern other AI features (training plan, nutrition,
// sparring review, opponent analysis, fight camp builder) should follow.
// Each of those is the same shape: validate input -> runAiRequest with a
// feature-specific system prompt -> shape the response -> return.
// ============================================================================

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/middleware');
const { aiRateLimit } = require('../auth/rate_limit');
const { runAiRequest, AiRequestError } = require('../anthropic/anthropic_service');
const { InsufficientCreditsError } = require('../credits/credit_service');

const COACH_SYSTEM_PROMPT = `You are the AI coach for the Hybrid Warfare Muay Thai system...`; // full prompt as built in the app

router.post('/api/coach/ask', requireAuth, aiRateLimit, async (req, res, next) => {
  const { question } = req.body;

  if (!question || typeof question !== 'string' || question.length > 2000) {
    return res.status(400).json({ error: 'A question (max 2000 characters) is required.' });
  }

  try {
    const { response, creditsCharged } = await runAiRequest({
      userId: req.user.id,
      feature: 'ai_coach_question',
      anthropicParams: {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: COACH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: question }],
      },
    });

    const textContent = response.content.find(block => block.type === 'text')?.text || '';

    res.json({
      answer: textContent,
      creditsCharged,
      // Client uses this to update the displayed balance without a
      // separate round-trip to /api/users/me
      remainingCredits: await require('../credits/credit_service').getBalance(req.user.id),
    });

  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return res.status(402).json({
        error: 'Not enough credits for this request.',
        required: err.required,
        available: err.available,
        // Client should deep-link to the Store page using this
        action: 'PURCHASE_CREDITS',
      });
    }
    if (err instanceof AiRequestError) {
      return res.status(502).json({ error: err.message });
    }
    next(err); // unexpected error -> global error handler -> 500 + logged to Sentry/etc
  }
});

module.exports = router;
