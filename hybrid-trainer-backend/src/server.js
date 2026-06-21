require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const app = express();
console.log('>>> MARKER_TEST_12345 — if you see this in Render logs, the new server.js is running <<<');
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
app.set('trust proxy', 1);
app.use(require('./routes/stripe_webhook_routes'));
app.use(express.json({ limit: '2mb' }));
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString(), marker: 'MARKER_TEST_12345' }));
app.use(require('./routes/auth_routes'));
app.use(require('./routes/user_routes'));
app.use(require('./routes/billing_routes'));
app.use(require('./routes/coach_routes'));
app.use(require('./routes/nutrition_routes'));
app.use(require('./routes/food_routes'));
app.use(require('./routes/sparring_routes'));
app.use(require('./routes/opponent_routes'));
app.use(require('./routes/ai_feature_routes'));
app.use(require('./routes/admin_routes'));
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  const statusCode = err.statusCode || 500;
  const message = statusCode === 500 ? 'Internal server error.' : err.message;
  res.status(statusCode).json({ error: message });
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hybrid Trainer API listening on port ${PORT}`);
});
