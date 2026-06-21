// ============================================================================
// USER ROUTES — profile, credit balance, transaction history. Powers the
// mobile app's Dashboard screen.
// ============================================================================

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../auth/middleware');
const pool = require('../db/pool');

router.get('/api/users/me', requireAuth, async (req, res, next) => {
  try {
    const userResult = await pool.query(
      `SELECT id, email, username, membership_type, credits, created_at FROM users WHERE id = $1`,
      [req.user.id]
    );
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Active subscription details, if any — lets the Dashboard show
    // "renews June 24" without a separate API call.
    const subResult = await pool.query(
      `SELECT status, current_period_end, cancel_at_period_end
       FROM subscriptions WHERE user_id = $1 AND status IN ('active','past_due') ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );

    res.json({ user, subscription: subResult.rows[0] || null });
  } catch (err) { next(err); }
});

router.get('/api/credits/transactions', requireAuth, async (req, res, next) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const offset = parseInt(req.query.offset, 10) || 0;

  try {
    const result = await pool.query(
      `SELECT id, action, credits_delta, balance_after, metadata, created_at
       FROM credit_transactions
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.user.id, limit, offset]
    );
    res.json({ transactions: result.rows, limit, offset });
  } catch (err) { next(err); }
});

module.exports = router;
