// ============================================================================
// RATE LIMITING — Redis-backed, because at 100k+ users you're running
// multiple API server instances behind a load balancer. An in-memory
// rate limiter (e.g. express-rate-limit's default MemoryStore) tracks
// limits per-instance, so a user hitting different instances on
// different requests effectively gets N× the intended limit, where N
// is your instance count. Redis gives one shared counter across all
// instances.
// ============================================================================

const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

/**
 * Sliding-window rate limiter using Redis sorted sets.
 * More accurate than fixed-window counters (which allow 2x burst at
 * window boundaries) and cheap enough at this scale.
 */
async function checkRateLimit({ key, maxRequests, windowSeconds }) {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const redisKey = `ratelimit:${key}`;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(redisKey, 0, windowStart); // drop entries outside the window
  pipeline.zadd(redisKey, now, `${now}-${Math.random()}`); // unique member per request
  pipeline.zcard(redisKey); // count requests currently in window
  pipeline.expire(redisKey, windowSeconds);

  const results = await pipeline.exec();
  const requestCount = results[2][1];

  return {
    allowed: requestCount <= maxRequests,
    remaining: Math.max(0, maxRequests - requestCount),
    retryAfterSeconds: windowSeconds,
  };
}

// ----------------------------------------------------------------------------
// General API rate limit — applied to every authenticated route.
// Generous, just to stop runaway clients/bugs, not meant to be a business
// control.
// ----------------------------------------------------------------------------
function generalRateLimit(req, res, next) {
  const key = `general:${req.user?.id || req.ip}`;
  checkRateLimit({ key, maxRequests: 120, windowSeconds: 60 })
    .then(({ allowed, remaining, retryAfterSeconds }) => {
      res.set('X-RateLimit-Remaining', remaining);
      if (!allowed) {
        return res.status(429).json({ error: 'Too many requests. Please slow down.', retryAfter: retryAfterSeconds });
      }
      next();
    })
    .catch(next);
}

// ----------------------------------------------------------------------------
// AI endpoint rate limit — stricter, and tiered by membership. This is
// what actually protects your Anthropic spend from a single compromised
// or abusive account hammering the most expensive endpoints.
// ----------------------------------------------------------------------------
const AI_RATE_LIMITS = {
  free: { maxRequests: 10, windowSeconds: 3600 },   // 10/hour
  pro:  { maxRequests: 60, windowSeconds: 3600 },    // 60/hour
  admin:{ maxRequests: 200, windowSeconds: 3600 },
};

function aiRateLimit(req, res, next) {
  const tier = req.user?.role || 'free';
  const limits = AI_RATE_LIMITS[tier] || AI_RATE_LIMITS.free;
  const key = `ai:${req.user.id}`;

  checkRateLimit({ key, maxRequests: limits.maxRequests, windowSeconds: limits.windowSeconds })
    .then(({ allowed, remaining, retryAfterSeconds }) => {
      res.set('X-AI-RateLimit-Remaining', remaining);
      if (!allowed) {
        return res.status(429).json({
          error: `AI request rate limit reached (${limits.maxRequests}/hour for ${tier} tier). Upgrade to Pro for a higher limit.`,
          retryAfter: retryAfterSeconds,
        });
      }
      next();
    })
    .catch(next);
}

// ----------------------------------------------------------------------------
// Login attempt limiter — by IP, independent of the per-user lockout
// in auth_service.js. Stops credential-stuffing across many accounts
// from a single source.
// ----------------------------------------------------------------------------
function loginRateLimit(req, res, next) {
  const key = `login:${req.ip}`;
  checkRateLimit({ key, maxRequests: 20, windowSeconds: 600 }) // 20 attempts / 10 min / IP
    .then(({ allowed, retryAfterSeconds }) => {
      if (!allowed) {
        return res.status(429).json({ error: 'Too many login attempts from this network. Try again later.', retryAfter: retryAfterSeconds });
      }
      next();
    })
    .catch(next);
}

module.exports = { checkRateLimit, generalRateLimit, aiRateLimit, loginRateLimit };
