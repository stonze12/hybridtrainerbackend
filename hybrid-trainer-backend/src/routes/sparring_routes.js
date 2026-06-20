// ============================================================================
// SPARRING / TECHNIQUE ANALYSIS ROUTE \u2014 matches the app's real Analyze
// tab exactly: combo metadata + a focus area + 4-8 inline base64 JPEG
// frames extracted client-side from the video (NOT pre-uploaded URLs \u2014
// the original route stub assumed cloud-storage URLs, which isn't how
// the app actually works; it extracts frames to canvas and sends them
// directly, the same pattern as the Coach and Opponent Scout features).
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

const ANALYZE_VISION_SYSTEM = `You are the AI coach for the Hybrid Warfare Muay Thai system by Ryan D. Whetstone. You are analyzing video frames of a practitioner performing a specific combination from this system.

The Hybrid Warfare system has ONE mandatory rule above all others: every combination ends with a mandatory exit direction tied to the final strike.
- Ends right hand or right kick → EXIT RIGHT (pivot left foot, step right, reset outside their left shoulder)
- Ends left hand or left kick → EXIT LEFT (step left, pivot right foot)
- Ends knee from clinch → EXIT BACK
- Ends elbow → EXIT AWAY FROM THAT ARM

STANCE: Orthodox base. Weight 60/40 front/back. Lead foot at 45°, rear foot at 90°. Shoulder-width stance. Guard: lead hand at chin height, rear hand at cheekbone.

FOOTWORK (Layer 1 — Lomachenko): The step IS the first strike. Outside-shoulder positioning on every entry. The pivot is a weapon, not a reset.

POWER GENERATION (Layer 2 — Buakaw): Hip rotation drives all kicks. Cross starts rotation from rear hip, not shoulder. Low kick: full hip turnover, step into the kick, snap through.

You will receive 4–8 frames from a short clip. Analyze the sequence as a motion — not just static frames.

Respond ONLY with a valid JSON object, no markdown, no preamble:
{
  "combo_identified": "name or unclear",
  "overall": "2-3 sentence overall assessment, specific and honest",
  "scores": {
    "exit_direction": { "score": 0-10, "note": "one sentence — did they exit the correct direction?" },
    "guard": { "score": 0-10, "note": "one sentence — guard during combination" },
    "stance_footwork": { "score": 0-10, "note": "one sentence — stance width, weight, pivot quality" },
    "power_mechanics": { "score": 0-10, "note": "one sentence — hip rotation, commitment" },
    "timing_flow": { "score": 0-10, "note": "one sentence — rhythm, hesitation, combination speed" }
  },
  "top_fix": "The single most important technical correction, with the exact physical cue",
  "drill": {
    "name": "exact drill name from the system",
    "protocol": "exact sets/duration/instructions",
    "why": "one sentence connecting this drill to what you saw"
  }
}`;

const FOCUS_MAP = {
  exit: 'Pay special attention to exit direction after the final strike.',
  guard: 'Pay special attention to guard position throughout.',
  stance: 'Pay special attention to stance width, weight, and footwork.',
  power: 'Pay special attention to hip rotation and power generation.',
  timing: 'Pay special attention to timing, rhythm, and flow.',
  all: 'Analyze all aspects equally.',
};

router.post('/api/sparring/review', requireAuth, aiRateLimit, async (req, res, next) => {
  const { comboNum, comboName, strikes, exitDetail, focus, frames } = req.body;

  if (!comboNum || !comboName || !Array.isArray(frames) || frames.length === 0) {
    return res.status(400).json({ error: 'comboNum, comboName, and frames (array of base64 JPEG strings) are required.' });
  }
  if (frames.length > 8) {
    return res.status(400).json({ error: 'Maximum 8 frames per analysis.' });
  }
  // Rough sanity cap \u2014 8 frames at the app's ~480px scale should never
  // approach this; catches abuse via oversized payloads.
  const totalSize = frames.reduce((sum, f) => sum + f.length, 0);
  if (totalSize > 15_000_000) {
    return res.status(400).json({ error: 'Frames payload too large.' });
  }

  const userContent = [
    {
      type: 'text',
      text: `I am performing Combination ${comboNum}: ${comboName}.\nSequence: ${(strikes || []).join(' \u2192 ')}\nCorrect exit: ${exitDetail || 'not specified'}\n\n${FOCUS_MAP[focus] || FOCUS_MAP.all}\n\nHere are ${frames.length} frames from my clip. Return JSON only.`,
    },
    ...frames.map(b64 => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } })),
  ];

  try {
    const { response, creditsCharged } = await runAiRequest({
      userId: req.user.id,
      feature: 'sparring_review',
      anthropicParams: {
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: ANALYZE_VISION_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
      },
    });

    let result;
    try {
      const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      return res.status(502).json({ error: 'Analysis returned malformed data \u2014 try again.' });
    }

    res.json({
      result,
      creditsCharged,
      remainingCredits: await creditService.getBalance(req.user.id),
    });
  } catch (err) { handleAiError(err, res, next); }
});

module.exports = router;
