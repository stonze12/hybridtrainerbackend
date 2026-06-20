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
    const { response, creditsCharged } = await runAiRequest({
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
    });
  } catch (err) { handleAiError(err, res, next); }
});

// ----------------------------------------------------------------------------
// NUTRITION PLAN — 10 credits
// ----------------------------------------------------------------------------
const NUTRITION_SYSTEM_PROMPT = `You are a nutrition plan generator for Muay Thai fighters following the Hybrid Warfare system. Given the user's bodyweight, goal (cut/maintain/lean-bulk/recomposition), and training frequency, produce a personalized macro target and a sample meal structure. Use the Mifflin-St Jeor formula for BMR/TDEE calculations.`;

router.post('/api/nutrition/generate', requireAuth, aiRateLimit, async (req, res, next) => {
  const { bodyweightLbs, goal, trainingDaysPerWeek, age, sex, heightInches } = req.body;
  if (!bodyweightLbs || !goal || !trainingDaysPerWeek) {
    return res.status(400).json({ error: 'bodyweightLbs, goal, and trainingDaysPerWeek are required.' });
  }
  try {
    const { response, creditsCharged } = await runAiRequest({
      userId: req.user.id,
      feature: 'nutrition_plan',
      anthropicParams: {
        model: 'claude-sonnet-4-6',
        max_tokens: 1536,
        system: NUTRITION_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Bodyweight: ${bodyweightLbs} lbs\nGoal: ${goal}\nTraining days/week: ${trainingDaysPerWeek}\nAge: ${age || 'not provided'}\nSex: ${sex || 'not provided'}\nHeight: ${heightInches || 'not provided'} inches`,
        }],
      },
    });
    res.json({
      plan: textFromResponse(response),
      creditsCharged,
      remainingCredits: await creditService.getBalance(req.user.id),
    });
  } catch (err) { handleAiError(err, res, next); }
});

// ----------------------------------------------------------------------------
// SPARRING REVIEW — 20 credits
// Expects video to already be uploaded to object storage (see
// ARCHITECTURE.md §11) — this route receives a URL/key, not the file
// itself, so large uploads never transit the API server.
// ----------------------------------------------------------------------------
const SPARRING_REVIEW_SYSTEM_PROMPT = `You are reviewing sparring footage for a practitioner of the Hybrid Warfare Muay Thai system. Analyze technique, footwork, exit discipline after combinations, and defensive habits. Give specific, actionable feedback tied to the system's named combinations and footwork vocabulary where relevant.`;

router.post('/api/sparring/review', requireAuth, aiRateLimit, async (req, res, next) => {
  const { videoFrameUrls, focusArea } = req.body; // pre-extracted frames, uploaded client-side to object storage
  if (!videoFrameUrls || !Array.isArray(videoFrameUrls) || videoFrameUrls.length === 0) {
    return res.status(400).json({ error: 'videoFrameUrls (array of image URLs) is required.' });
  }
  try {
    const imageBlocks = videoFrameUrls.slice(0, 10).map(url => ({
      type: 'image', source: { type: 'url', url },
    }));

    const { response, creditsCharged } = await runAiRequest({
      userId: req.user.id,
      feature: 'sparring_review',
      anthropicParams: {
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SPARRING_REVIEW_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            ...imageBlocks,
            { type: 'text', text: `Focus area requested: ${focusArea || 'general review'}. Here are frames from my sparring round. Give your analysis.` },
          ],
        }],
      },
    });
    res.json({
      review: textFromResponse(response),
      creditsCharged,
      remainingCredits: await creditService.getBalance(req.user.id),
    });
  } catch (err) { handleAiError(err, res, next); }
});

// ----------------------------------------------------------------------------
// OPPONENT ANALYSIS — 25 credits
// ----------------------------------------------------------------------------
const OPPONENT_ANALYSIS_SYSTEM_PROMPT = `You are analyzing an opponent's fighting tendencies for a practitioner preparing to face them, using the Hybrid Warfare Muay Thai system's framework of fighter archetypes. Identify patterns, likely tendencies, and suggest which of the system's combinations and footwork would be most effective against this specific opponent profile.`;

router.post('/api/opponent/analyze', requireAuth, aiRateLimit, async (req, res, next) => {
  const { opponentDescription, videoFrameUrls } = req.body;
  if (!opponentDescription && (!videoFrameUrls || videoFrameUrls.length === 0)) {
    return res.status(400).json({ error: 'Provide opponentDescription text and/or videoFrameUrls.' });
  }
  try {
    const content = [];
    if (videoFrameUrls?.length) {
      content.push(...videoFrameUrls.slice(0, 10).map(url => ({ type: 'image', source: { type: 'url', url } })));
    }
    content.push({ type: 'text', text: opponentDescription || 'Analyze the opponent shown in these frames.' });

    const { response, creditsCharged } = await runAiRequest({
      userId: req.user.id,
      feature: 'opponent_analysis',
      anthropicParams: {
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: OPPONENT_ANALYSIS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      },
    });
    res.json({
      analysis: textFromResponse(response),
      creditsCharged,
      remainingCredits: await creditService.getBalance(req.user.id),
    });
  } catch (err) { handleAiError(err, res, next); }
});

// ----------------------------------------------------------------------------
// FIGHT CAMP BUILDER — 30 credits (most expensive feature, longest output)
// ----------------------------------------------------------------------------
const FIGHT_CAMP_SYSTEM_PROMPT = `You are building a full fight camp plan for a Hybrid Warfare Muay Thai practitioner with a confirmed fight date. Produce a week-by-week periodized plan from today through fight week, covering technical work, conditioning, strength, taper, and weight management, consistent with the system's existing 24-week block structure where applicable.`;

router.post('/api/fight-camp/build', requireAuth, aiRateLimit, async (req, res, next) => {
  const { weeksUntilFight, currentLevel, weightClass, opponentNotes } = req.body;
  if (!weeksUntilFight || !currentLevel) {
    return res.status(400).json({ error: 'weeksUntilFight and currentLevel are required.' });
  }
  try {
    const { response, creditsCharged } = await runAiRequest({
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
    });
  } catch (err) { handleAiError(err, res, next); }
});

module.exports = router;
