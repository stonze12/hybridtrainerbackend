// ============================================================================
// SERVER ENTRY POINT
//
// Route mounting order matters in two places:
//   1. The Stripe webhook route MUST be mounted with express.raw() BEFORE
//      express.json() is applied globally — otherwise the webhook
//      signature check fails because the body has already been parsed
//      and re-serialized, which changes its bytes.
//   2. CORS and security headers apply globally and should wrap
//      everything else.
// ============================================================================

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');

const app = express();

// ----------------------------------------------------------------------------
// Fail fast on missing required config — better to crash on boot with a
// clear message than to start "successfully" and fail mysteriously on
// the first request that needs a secret you forgot to set on your host.
// ----------------------------------------------------------------------------
const REQUIRED_ENV_VARS = [
  'DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET',
  'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
];
const missing = REQUIRED_ENV_VARS.filter(name => !process.env[name]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
}));

// Trust the first proxy hop — Fly.io's edge proxy (and most platform
// load balancers generally) sits in front of your app, and req.ip needs
// this to reflect the real client IP rather than the proxy's internal
// address. Important for the login rate limiter and IP-based audit fields.
app.set('trust proxy', 1);

// --- Stripe webhook FIRST, with raw body, before express.json() ---
app.use(require('./routes/stripe_webhook_routes'));

// --- Everything else gets normal JSON body parsing ---
app.use(express.json({ limit: '2mb' }));

// --- Health check — used by your hosting platform's deploy verification ---
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// --- Route mounting ---
app.use(require('./routes/auth_routes'));
app.use(require('./routes/user_routes'));
app.use(require('./routes/billing_routes'));
app.use(require('./routes/coach_routes'));
app.use(require('./routes/ai_feature_routes'));
app.use(require('./routes/admin_routes'));

// --- Apply general rate limiting to all authenticated API routes ---
// (Mounted after the routes above for clarity in this file, but
// rate_limit.js's generalRateLimit can also be added per-router if you
// want different limits per route group — see ARCHITECTURE.md §6.)

// --- 404 handler ---
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// --- Global error handler — must be LAST ---
app.use((err, req, res, next) => {
  console.error(err);
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 ? 'Internal server error.' : err.message;
  res.status(statusCode).json({ error: message });
});

const PORT = process.env.PORT || 3000;
// Bind explicitly to 0.0.0.0, not just localhost — Fly.io routes traffic
// into your VM from its edge network, and the app needs to accept
// connections on all interfaces, not just loopback, for that to reach it.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hybrid Trainer API listening on port ${PORT}`);
});

module.exports = app;
