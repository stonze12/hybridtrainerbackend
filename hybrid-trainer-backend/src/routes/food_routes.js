// ============================================================================
// FOOD ROUTES — text-based food search (Haiku, cheapest call in the app)
// and food-photo macro estimation (Sonnet, single image). These two
// features didn't exist in the original route set; built to match
// exactly what the app's Fuel tab sends.
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

function jsonFromResponse(response) {
  const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
}

// ----------------------------------------------------------------------------
// FOOD SEARCH — 1 credit, claude-haiku-4-5 (cheapest call in the app)
// ----------------------------------------------------------------------------
const FOOD_SEARCH_SYSTEM = 'You are a nutrition database. Return ONLY a JSON array (no markdown, no explanation) of up to 6 foods matching the query. Each item: {"name":"string","cal100":number,"pro100":number,"carb100":number,"fat100":number} \u2014 all macros per 100g. Be precise with real nutritional values.';

router.post('/api/food/search', requireAuth, aiRateLimit, async (req, res, next) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.length > 200) {
    return res.status(400).json({ error: 'query (max 200 characters) is required.' });
  }
  try {
    const { response, creditsCharged } = await runAiRequest({
      userId: req.user.id,
      feature: 'food_search',
      anthropicParams: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: FOOD_SEARCH_SYSTEM,
        messages: [{ role: 'user', content: `Nutrition data for: ${query}` }],
      },
    });

    let products;
    try { products = jsonFromResponse(response); }
    catch (e) { return res.status(502).json({ error: 'Search returned malformed data \u2014 try again.' }); }

    res.json({
      products,
      creditsCharged,
      remainingCredits: await creditService.getBalance(req.user.id),
    });
  } catch (err) { handleAiError(err, res, next); }
});

// ----------------------------------------------------------------------------
// FOOD PHOTO ESTIMATE \u2014 2 credits, claude-sonnet-4-6, single image
// ----------------------------------------------------------------------------
const FOOD_PHOTO_SYSTEM = 'You are a nutrition estimation tool. The user will send you a photo of food. Estimate the total macros and calories for everything visible on the plate. Return ONLY valid JSON, no markdown: {"name":"short descriptive name","calories":number,"protein_g":number,"carbs_g":number,"fat_g":number,"confidence":"low|medium|high","notes":"one sentence caveat if needed"}';

router.post('/api/food/photo-estimate', requireAuth, aiRateLimit, async (req, res, next) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return res.status(400).json({ error: 'imageBase64 is required.' });
  }
  // Rough sanity cap on payload size \u2014 a single food photo shouldn't
  // need to be huge; this also limits abuse via oversized uploads.
  if (imageBase64.length > 8_000_000) {
    return res.status(400).json({ error: 'Image too large.' });
  }

  try {
    const { response, creditsCharged } = await runAiRequest({
      userId: req.user.id,
      feature: 'food_photo_estimate',
      anthropicParams: {
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        system: FOOD_PHOTO_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: 'Estimate the macros and calories for this meal.' },
          ],
        }],
      },
    });

    let result;
    try { result = jsonFromResponse(response); }
    catch (e) { return res.status(502).json({ error: 'Photo estimate returned malformed data \u2014 try again.' }); }

    res.json({
      result,
      creditsCharged,
      remainingCredits: await creditService.getBalance(req.user.id),
    });
  } catch (err) { handleAiError(err, res, next); }
});

module.exports = router;
