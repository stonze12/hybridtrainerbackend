const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);

async function checkRateLimit({ key, maxRequests, windowSeconds }) {
  const now = Date.now();
  const windowStart = now - windowSeconds * 1000;
  const redisKey = `ratelimit:${key}`;

  const pipeline = redis.pipeline();
  pipeline.zremrangebyscore(redisKey, 0, windowStart);
  pipeline.zadd(redisKey, now, `${now}-${Math.random()}`);
  pipeline.zcard(redisKey);
  pipeline.expire(redisKey, windowSeconds);

  const results = await pipeline.exec();
  const requestCount = results[2][1];

  return {
    allowed: requestCount <= maxRequests,
    remaining: Math.max(0, maxRequests - requestCount),
    retryAfterSeconds: windowSeconds,
  };
}

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

const AI_RATE_LIMITS = {
  free: { maxRequests: 10, windowSeconds: 3600 },
  pro:  { maxRequests: 60, windowSeconds: 3600 },
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

function loginRateLimit(req, res, next) {
  next();
}

module.exports = { checkRateLimit, generalRateLimit, aiRateLimit, loginRateLimit };
