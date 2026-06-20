// ============================================================================
// ADMIN DASHBOARD ROUTES — all gated by requireRole('admin')
// ============================================================================

const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../auth/middleware');
const analytics = require('../admin/analytics_service');
const pool = require('../db/pool');

router.use(requireAuth, requireRole('admin'));

function parseDateRange(req) {
  const endDate = req.query.endDate ? new Date(req.query.endDate) : new Date();
  const startDate = req.query.startDate
    ? new Date(req.query.startDate)
    : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000); // default: trailing 30 days
  return { startDate, endDate };
}

router.get('/api/admin/overview', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req);
    res.json(await analytics.getOverviewMetrics({ startDate, endDate }));
  } catch (err) { next(err); }
});

router.get('/api/admin/revenue-by-day', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req);
    res.json(await analytics.getRevenueBreakdownByDay({ startDate, endDate }));
  } catch (err) { next(err); }
});

router.get('/api/admin/feature-usage', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req);
    res.json(await analytics.getFeatureUsageBreakdown({ startDate, endDate }));
  } catch (err) { next(err); }
});

router.get('/api/admin/top-spenders', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req);
    res.json(await analytics.getTopSpendingUsers({ startDate, endDate, limit: parseInt(req.query.limit) || 50 }));
  } catch (err) { next(err); }
});

router.get('/api/admin/churn', async (req, res, next) => {
  try {
    const { startDate, endDate } = parseDateRange(req);
    res.json(await analytics.getChurnMetrics({ startDate, endDate }));
  } catch (err) { next(err); }
});

// ----------------------------------------------------------------------------
// User lookup + manual credit adjustment — every manual adjustment is
// logged to admin_audit_log with the admin's own id, never anonymous.
// ----------------------------------------------------------------------------
router.get('/api/admin/users/:userId', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, email, username, membership_type, credits, created_at, stripe_customer_id
       FROM users WHERE id = $1`,
      [req.params.userId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'User not found.' });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

router.post('/api/admin/users/:userId/adjust-credits', async (req, res, next) => {
  const { amount, reason } = req.body;
  if (!Number.isInteger(amount) || amount === 0) {
    return res.status(400).json({ error: 'amount must be a non-zero integer.' });
  }
  if (!reason || reason.trim().length < 5) {
    return res.status(400).json({ error: 'A reason of at least 5 characters is required for audit purposes.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let result;
    if (amount > 0) {
      result = await client.query(
        `SELECT * FROM grant_credits($1, $2, 'admin_adjustment', NULL, $3)`,
        [req.params.userId, amount, JSON.stringify({ reason, adminId: req.user.id })]
      );
    } else {
      result = await client.query(
        `SELECT * FROM deduct_credits($1, $2, 'admin_adjustment', NULL, $3)`,
        [req.params.userId, Math.abs(amount), JSON.stringify({ reason, adminId: req.user.id })]
      );
      if (!result.rows[0].success) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Cannot deduct more credits than the user has.' });
      }
    }

    await client.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_user_id, details)
       VALUES ($1, 'manual_credit_adjustment', $2, $3)`,
      [req.user.id, req.params.userId, JSON.stringify({ amount, reason })]
    );

    await client.query('COMMIT');
    res.json({ success: true, newBalance: result.rows[0].new_balance });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
