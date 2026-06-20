// ============================================================================
// AUTH MIDDLEWARE — verifies JWT access tokens, attaches req.user, and
// provides role-gating for routes (free / pro / admin).
// ============================================================================

const jwt = require('jsonwebtoken');
const ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_SECRET;

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, ACCESS_TOKEN_SECRET, { issuer: 'hybrid-trainer-api' });
    if (payload.type !== 'access') {
      return res.status(401).json({ error: 'Invalid token type.' });
    }
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Access token expired.', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid access token.' });
  }
}

// Role hierarchy: admin can do anything pro can do, pro can do anything
// free can do. requireRole('pro') allows both 'pro' and 'admin' through.
const ROLE_RANK = { free: 0, pro: 1, admin: 2 };

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    const userRank = ROLE_RANK[req.user.role] ?? -1;
    const requiredRank = ROLE_RANK[minRole] ?? 99;
    if (userRank < requiredRank) {
      return res.status(403).json({ error: `This feature requires ${minRole} membership or higher.` });
    }
    next();
  };
}

// IMPORTANT: req.user.role comes from the JWT, which is only refreshed
// every 15 minutes (the access token TTL). If an admin downgrades a user's
// role mid-session, that user's existing access token still carries the
// old role for up to 15 minutes. This is an accepted tradeoff for
// stateless tokens — if you need instant revocation of role changes,
// check membership_type from the DB on sensitive operations instead of
// trusting the JWT claim, or shorten the access token TTL further.
// For credit-gated AI features specifically, the credit check always
// hits the DB anyway (see credit_service.js), so a stale role claim
// can't be used to bypass billing — it could only affect feature-gating
// UI, which is low-stakes.

module.exports = { requireAuth, requireRole };
