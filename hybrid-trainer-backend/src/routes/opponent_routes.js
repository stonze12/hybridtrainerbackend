// ============================================================================
// OPPONENT SCOUT ROUTE \u2014 matches the app's real Scout tab: optional text
// context plus up to 8 inline base64 JPEG frames extracted client-side.
// Same inline-frames pattern as sparring_routes.js, not the URL-based
// shape the original route stub assumed.
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

const SCOUT_SYSTEM = `You are the AI coach for the Hybrid Warfare Muay Thai system by Ryan D. Whetstone. You are analyzing video frames of an OPPONENT, not the user. Your job is to:
1. Identify the opponent's fighting patterns, tendencies, strengths, and weaknesses from the footage
2. Generate a specific game plan for beating this opponent using the Hybrid Warfare system's 18 combinations and tactical framework

The system the user fights in:
- Orthodox base stance, three layers: Lomachenko footwork (angles), Buakaw pressure (low kicks, teeps, clinch), Saenchai creativity (feints, switches)
- Mandatory exit direction after every combination
- 5 opponent archetypes: Forward Pressure Fighter, Counter Fighter, Pure Kicker, Boxer (hand-heavy), Passive/Defensive Fighter

Respond ONLY with valid JSON, no markdown:
{
  "archetype": "which of the 5 archetypes best describes this opponent",
  "summary": "2-3 sentences describing their overall style and what makes them dangerous",
  "strengths": [
    {"label":"strength name","detail":"one sentence","threat":"high|med|low"},
    {"label":"strength name","detail":"one sentence","threat":"high|med|low"},
    {"label":"strength name","detail":"one sentence","threat":"high|med|low"}
  ],
  "weaknesses": [
    {"label":"weakness name","detail":"one sentence — how to exploit it"},
    {"label":"weakness name","detail":"one sentence — how to exploit it"},
    {"label":"weakness name","detail":"one sentence — how to exploit it"}
  ],
  "gameplan_combos": [
    {"combo_num":1,"name":"Saenchai Ghost","why":"one sentence why this combo works specifically against this opponent"},
    {"combo_num":2,"name":"Loma Angle","why":"one sentence why this combo works specifically against this opponent"},
    {"combo_num":3,"name":"Buakaw Pressure","why":"one sentence why this combo works specifically against this opponent"}
  ],
  "round_tactics": "2-3 sentences on how to approach the fight round by round using the hybrid system — what to establish early, what to build toward, what to watch for",
  "key_warning": "The single most important tactical caution — what NOT to do against this specific opponent"
}`;

router.post('/api/opponent/analyze', requireAuth, aiRateLimit, async (req, res, next) => {
  const { context, frames } = req.body;

  if (!Array.isArray(frames) || frames.length === 0) {
    return res.status(400).json({ error: 'frames (array of base64 JPEG strings) is required.' });
  }
  if (frames.length > 8) {
    return res.status(400).json({ error: 'Maximum 8 frames per scout.' });
  }
  const totalSize = frames.reduce((sum, f) => sum + f.length, 0);
  if (totalSize > 15_000_000) {
    return res.status(400).json({ error: 'Frames payload too large.' });
  }

  const userContent = [
    {
      type: 'text',
      text: `Scout this opponent for me. ${context ? 'Additional context: ' + context : ''} Analyze all ${frames.length} frames and return JSON only.`,
    },
    ...frames.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })),
  ];

  try {
    const { response, creditsCharged } = await runAiRequest({
      userId: req.user.id,
      feature: 'opponent_analysis',
      anthropicParams: {
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: SCOUT_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      },
    });

    let result;
    try {
      const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      return res.status(502).json({ error: 'Scout returned malformed data \u2014 try again.' });
    }

    res.json({
      result,
      creditsCharged,
      remainingCredits: await creditService.getBalance(req.user.id),
    });
  } catch (err) { handleAiError(err, res, next); }
});

module.exports = router;
