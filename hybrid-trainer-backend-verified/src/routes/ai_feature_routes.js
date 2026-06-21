// ============================================================================
// AI FEATURE ROUTES — training plans, nutrition, sparring review, opponent
// analysis, fight camp builder. Same pattern as coach_routes.js: validate
// input -> runAiRequest with a feature-specific prompt -> shape response.
//
// Grouped into one file here for brevity; nothing stops you from splitting
// each into its own file as the prompts grow — there's no shared state
// between them beyond the imports.
// ============================================================================

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/middleware');
const { aiRateLimit } = require('../auth/rate_limit');
const { runAiRequest, AiRequestError } = require('../anthropic/anthropic_service');
const { InsufficientCreditsError } = require('../credits/credit_service');
const creditService = require('../credits/credit_service');

// Shared error handler — identical shape across every AI feature so the
// mobile client only needs one "out of credits" component (see
// ARCHITECTURE.md §11) regardless of which screen triggered it.
function handleAiError(err, res, next) {
  if (err instanceof InsufficientCreditsError) {
    return res.status(402).json({
      error: 'Not enough credits for this request.',
      required: err.required,
      available: err.available,
      action: 'PURCHASE_CREDITS',
    });
  }
  if (err instanceof AiRequestError) {
    return res.status(502).json({ error: err.message });
  }
  next(err);
}

function textFromResponse(response) {
  return response.content.find(block => block.type === 'text')?.text || '';
}

// ----------------------------------------------------------------------------
// CUSTOM TRAINING PLAN — 15 credits
// ----------------------------------------------------------------------------
const TRAINING_PLAN_SYSTEM_PROMPT = `You are a training plan generator for the Hybrid Warfare Muay Thai system. Given the user's experience level, goals, available training days, and any injury constraints, produce a structured weekly training plan consistent with the system's combos, drills, and conditioning philosophy. Be specific about sets, reps, and rest periods.`;

router.post('/api/training-plans/generate', requireAuth, aiRateLimit, async (req, res, next) => {
  const { experienceLevel, goals, daysPerWeek, constraints } = req.body;
  if (!experienceLevel || !goals || !daysPerWeek) {
    return res.status(400).json({ error: 'experienceLevel, goals, and daysPerWeek are required.' });
  }
  try {
    const { response, creditsCharged, viaSubscription, allowanceUsed, allowanceLimit, tierLabel } = await runAiRequest({
      userId: req.user.id,
      feature: 'custom_training_plan',
      anthropicParams: {
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: TRAINING_PLAN_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Experience level: ${experienceLevel}\nGoals: ${goals}\nDays per week available: ${daysPerWeek}\nConstraints/injuries: ${constraints || 'none'}`,
        }],
      },
    });
    res.json({
      plan: textFromResponse(response),
      creditsCharged,
      remainingCredits: await creditService.getBalance(req.user.id),
      viaSubscription, allowanceUsed, allowanceLimit, tierLabel,
    });
  } catch (err) { handleAiError(err, res, next); }
});

// ----------------------------------------------------------------------------
// FIGHT CAMP BUILDER — 18 credits (per FEATURE_COSTS; longest output of any feature)
// ----------------------------------------------------------------------------
const FIGHT_CAMP_SYSTEM_PROMPT = `You are building a full fight camp plan for a Hybrid Warfare Muay Thai practitioner with a confirmed fight date. Produce a week-by-week periodized plan from today through fight week, covering technical work, conditioning, strength, taper, and weight management, consistent with the system's existing 24-week block structure where applicable.`;

router.post('/api/fight-camp/build', requireAuth, aiRateLimit, async (req, res, next) => {
  const { weeksUntilFight, currentLevel, weightClass, opponentNotes } = req.body;
  if (!weeksUntilFight || !currentLevel) {
    return res.status(400).json({ error: 'weeksUntilFight and currentLevel are required.' });
  }
  try {
    const { response, creditsCharged, viaSubscription, allowanceUsed, allowanceLimit, tierLabel } = await runAiRequest({
      userId: req.user.id,
      feature: 'fight_camp_builder',
      anthropicParams: {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096, // longest output of any feature — full multi-week plan
        system: FIGHT_CAMP_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Weeks until fight: ${weeksUntilFight}\nCurrent level: ${currentLevel}\nWeight class: ${weightClass || 'not specified'}\nOpponent notes: ${opponentNotes || 'none'}`,
        }],
      },
    });
    res.json({
      camp: textFromResponse(response),
      creditsCharged,
      remainingCredits: await creditService.getBalance(req.user.id),
      viaSubscription, allowanceUsed, allowanceLimit, tierLabel,
    });
  } catch (err) { handleAiError(err, res, next); }
});

module.exports = router;
