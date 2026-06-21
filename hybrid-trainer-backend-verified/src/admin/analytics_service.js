// ============================================================================
// ADMIN ANALYTICS SERVICE — powers the admin dashboard's metrics panels.
// These are read-heavy aggregate queries; at 100k+ users you do NOT want
// these computed live against the transactional tables on every dashboard
// page load. See the architecture doc for the materialized-view /
// nightly-rollup recommendation. The queries below are correct and can
// run live at moderate scale, but plan to migrate them behind a rollup
// table (e.g. daily_metrics) once query latency becomes noticeable.
// ============================================================================

const pool = require('../db/pool');

async function getOverviewMetrics({ startDate, endDate }) {
  const [
    totalUsers, activeSubscribers, revenue, creditsSold, creditsConsumed, apiCosts,
  ] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS count FROM users`),

    pool.query(
      `SELECT COUNT(*) AS count FROM subscriptions WHERE status = 'active'`
    ),

    pool.query(
      `SELECT
         COALESCE(SUM(amount_paid_cents), 0) AS credit_pack_revenue_cents
       FROM credit_purchases
       WHERE purchase_date BETWEEN $1 AND $2 AND status = 'completed'`,
      [startDate, endDate]
    ),

    pool.query(
      `SELECT COALESCE(SUM(credits_received), 0) AS total FROM credit_purchases
       WHERE purchase_date BETWEEN $1 AND $2 AND status = 'completed'`,
      [startDate, endDate]
    ),

    pool.query(
      `SELECT COALESCE(SUM(-credits_delta), 0) AS total FROM credit_transactions
       WHERE credits_delta < 0 AND created_at BETWEEN $1 AND $2`,
      [startDate, endDate]
    ),

    pool.query(
      `SELECT COALESCE(SUM(estimated_cost_cents), 0) AS total_cents FROM ai_requests
       WHERE status = 'success' AND created_at BETWEEN $1 AND $2`,
      [startDate, endDate]
    ),
  ]);

  // Subscription MRR is computed separately from one-time credit pack
  // revenue because they have different recognition characteristics —
  // MRR is recurring, credit packs are one-time. Surfacing both
  // separately (rather than a single blended "revenue" number) is more
  // useful for actually running the business.
  const mrrResult = await pool.query(
    `SELECT COUNT(*) * 1499 AS mrr_cents FROM subscriptions WHERE status = 'active'`
  );

  const creditPackRevenueCents = parseInt(revenue.rows[0].credit_pack_revenue_cents, 10);
  const mrrCents = parseInt(mrrResult.rows[0].mrr_cents, 10);
  const apiCostCents = parseFloat(apiCosts.rows[0].total_cents);

  return {
    totalUsers: parseInt(totalUsers.rows[0].count, 10),
    activeSubscribers: parseInt(activeSubscribers.rows[0].count, 10),
    monthlyRecurringRevenueCents: mrrCents,
    creditPackRevenueCents,
    totalRevenueCents: mrrCents + creditPackRevenueCents,
    creditsSold: parseInt(creditsSold.rows[0].total, 10),
    creditsConsumed: parseInt(creditsConsumed.rows[0].total, 10),
    anthropicApiCostCents: apiCostCents,
    // Profit estimate = revenue - API costs. Does NOT subtract Stripe
    // fees, infra, or payroll — label this clearly in the UI as "gross
    // margin on AI spend" rather than "profit" to avoid misleading
    // anyone reading the dashboard.
    grossMarginCents: (mrrCents + creditPackRevenueCents) - apiCostCents,
  };
}

async function getRevenueBreakdownByDay({ startDate, endDate }) {
  const result = await pool.query(
    `SELECT
       date_trunc('day', purchase_date) AS day,
       SUM(amount_paid_cents) AS revenue_cents,
       COUNT(*) AS purchase_count
     FROM credit_purchases
     WHERE purchase_date BETWEEN $1 AND $2 AND status = 'completed'
     GROUP BY 1 ORDER BY 1`,
    [startDate, endDate]
  );
  return result.rows;
}

async function getFeatureUsageBreakdown({ startDate, endDate }) {
  // Which features drive the most usage AND the most API cost — useful
  // for deciding whether a feature's credit price needs adjusting.
  const result = await pool.query(
    `SELECT
       feature,
       COUNT(*) AS request_count,
       SUM(credits_charged) AS total_credits_charged,
       SUM(estimated_cost_cents) AS total_api_cost_cents,
       AVG(latency_ms) AS avg_latency_ms,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failure_count
     FROM ai_requests
     WHERE created_at BETWEEN $1 AND $2
     GROUP BY feature
     ORDER BY total_api_cost_cents DESC`,
    [startDate, endDate]
  );
  return result.rows;
}

async function getTopSpendingUsers({ startDate, endDate, limit = 50 }) {
  // Surfaces both legitimate power users (good — candidates for case
  // studies / testimonials) and potential abuse (a free-tier account
  // somehow consuming far more than 25 credits warrants investigation).
  const result = await pool.query(
    `SELECT
       u.id, u.email, u.username, u.membership_type,
       COUNT(ar.id) AS request_count,
       SUM(ar.estimated_cost_cents) AS total_api_cost_cents
     FROM ai_requests ar
     JOIN users u ON u.id = ar.user_id
     WHERE ar.created_at BETWEEN $1 AND $2 AND ar.status = 'success'
     GROUP BY u.id, u.email, u.username, u.membership_type
     ORDER BY total_api_cost_cents DESC
     LIMIT $3`,
    [startDate, endDate, limit]
  );
  return result.rows;
}

async function getChurnMetrics({ startDate, endDate }) {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'canceled' AND canceled_at BETWEEN $1 AND $2) AS canceled_count,
       COUNT(*) FILTER (WHERE status = 'active') AS active_count
     FROM subscriptions`,
    [startDate, endDate]
  );
  const row = result.rows[0];
  const canceled = parseInt(row.canceled_count, 10);
  const active = parseInt(row.active_count, 10);
  return {
    canceledThisPeriod: canceled,
    currentActive: active,
    churnRatePercent: active > 0 ? (canceled / (active + canceled)) * 100 : 0,
  };
}

module.exports = {
  getOverviewMetrics, getRevenueBreakdownByDay, getFeatureUsageBreakdown,
  getTopSpendingUsers, getChurnMetrics,
};
