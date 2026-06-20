// ============================================================================
// NUTRITION (AI MEAL PLAN) ROUTE — matches the app's real Fuel tab data
// shape exactly: the full nfTargets object the app already computes
// client-side (TDEE, macros, goal, etc.), not a re-derived subset.
// ============================================================================

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/middleware');
const { aiRateLimit } = require('../auth/rate_limit');
const { runAiRequest, AiRequestError } = require('../anthropic/anthropic_service');
const { InsufficientCreditsError } = require('../credits/credit_service');
const creditService = require('../credits/credit_service');

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

const GOAL_LABELS = {
  cut: 'cutting (fat loss while preserving muscle)',
  maintain: 'maintaining current weight',
  'lean-bulk': 'lean bulking (muscle gain, minimal fat)',
  recomposition: 'body recomposition (simultaneous fat loss + muscle gain)',
};
const INTENSITY_LABELS = {
  sedentary: 'sedentary (desk job, little exercise)',
  light: 'light activity (1-2 training days/week)',
  moderate: 'moderate activity (3-4 training days/week)',
  high: 'high activity (5 training days/week — this Muay Thai program)',
  'very-high': 'very active (2x/day training or hard physical labour)',
};

const NUTRITION_SYSTEM_PROMPT = `You are a sports nutritionist creating a personalised 7-day Muay Thai fighter meal plan. Output ONLY a valid JSON array (no markdown, no explanation, no text before or after) of exactly 7 days. Each day:
{"day":"Monday","meals":[{"time":"7:00 AM","name":"Breakfast","items":["2 eggs scrambled","1 cup oats with banana","black coffee"]}]}
Include exactly 4 meals per day (Breakfast, Lunch, Pre-Training, Dinner). Keep item descriptions concise — no more than 6 words each. All portions must collectively hit the daily calorie and macro targets. Use varied, real foods. Every day must be genuinely different. Prioritise carbs pre-training and protein post-training.`;

router.post('/api/nutrition/generate', requireAuth, aiRateLimit, async (req, res, next) => {
  const { targets } = req.body; // the app's full nfTargets object
  if (!targets || !targets.bw || !targets.cal || !targets.pro || !targets.carb || !targets.fat) {
    return res.status(400).json({ error: 'targets (bw, cal, pro, carb, fat, goal, intensity) is required.' });
  }

  const seed = Math.floor(Math.random() * 9999);
  const userContext = `
Fighter profile:
- Body weight: ${targets.bw} lbs (${targets.bwKg ? targets.bwKg.toFixed(1) : (targets.bw * 0.453).toFixed(1)} kg)
- Daily calorie target: ${targets.cal} kcal
- Protein target: ${targets.pro}g / day
- Carbohydrate target: ${targets.carb}g / day
- Fat target: ${targets.fat}g / day
- Goal: ${GOAL_LABELS[targets.goal] || targets.goal}
- Activity level: ${INTENSITY_LABELS[targets.intensity] || targets.intensity}
- Age: ${targets.age || 'not specified'}, Sex: ${targets.sex || 'not specified'}
- Hydration target: ${targets.hydration || 8} cups / day
- Variation seed: ${seed}`;

  try {
    const { response, creditsCharged } = await runAiRequest({
      userId: req.user.id,
      feature: 'nutrition_plan',
      anthropicParams: {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: NUTRITION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Create my 7-day meal plan.\n${userContext}` }],
      },
    });

    let raw = (response.content.find(b => b.type === 'text')?.text || '[]').replace(/```json|```/g, '').trim();

    // Same truncation-repair logic the client used to do — now done
    // server-side so the client just gets clean, already-valid JSON
    // back, rather than needing its own repair logic duplicated.
    if (response.stop_reason === 'max_tokens') {
      let objs = 0, opens = 0;
      const lastComplete = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
      if (lastComplete > 0) raw = raw.slice(0, lastComplete + 1);
      for (const ch of raw) {
        if (ch === '[') opens++; if (ch === ']') opens--;
        if (ch === '{') objs++; if (ch === '}') objs--;
      }
      raw += '}'.repeat(Math.max(0, objs)) + ']'.repeat(Math.max(0, opens));
    }

    let days;
    try {
      days = JSON.parse(raw);
    } catch (parseErr) {
      return res.status(502).json({ error: 'The meal plan generator returned malformed output — please try again.' });
    }

    res.json({
      days,
      creditsCharged,
      remainingCredits: await creditService.getBalance(req.user.id),
    });
  } catch (err) { handleAiError(err, res, next); }
});

module.exports = router;
