// ============================================================================
// AUTH SERVICE — JWT access tokens (short-lived, stateless) + refresh
// tokens (long-lived, stored hashed in DB so they can be revoked).
//
// Why two token types instead of one long-lived JWT:
//   A single long-lived JWT can't be revoked before it expires — if a
//   device is stolen or a token leaks, you're stuck waiting out the
//   expiry. Short-lived access tokens (15 min) limit the blast radius;
//   the refresh token is the thing that's actually revocable, because
//   it's checked against the DB on every refresh.
// ============================================================================

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs'); // pure-JS implementation — same API as bcrypt, no native compilation step needed at deploy time
const crypto = require('crypto');
const pool = require('../db/pool');

const ACCESS_TOKEN_TTL = '15m';
const REFRESH_TOKEN_TTL_DAYS = 30;
const BCRYPT_ROUNDS = 12; // 12 is the current sane default; revisit every ~2 years as hardware improves

// Secrets MUST come from a secrets manager in production (AWS Secrets
// Manager, GCP Secret Manager, Vault) — never hardcode, never commit.
// Use SEPARATE secrets for access vs refresh tokens so a leak of one
// doesn't compromise the other token type.
const ACCESS_TOKEN_SECRET = process.env.JWT_ACCESS_SECRET;
const REFRESH_TOKEN_SECRET = process.env.JWT_REFRESH_SECRET;

if (!ACCESS_TOKEN_SECRET || !REFRESH_TOKEN_SECRET) {
  throw new Error('JWT secrets not configured — refusing to start');
}

function hashToken(token) {
  // Refresh tokens are stored hashed (like passwords) — if the DB leaks,
  // an attacker can't replay raw refresh tokens from the dump.
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.membership_type, // 'free' | 'pro' | 'admin' — checked by requireRole middleware
      type: 'access',
    },
    ACCESS_TOKEN_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL, issuer: 'hybrid-trainer-api' }
  );
}

function generateRefreshToken() {
  // Random opaque token, NOT a JWT — refresh tokens don't need to be
  // self-describing, they're just a lookup key into refresh_tokens.
  return crypto.randomBytes(48).toString('hex');
}

// ----------------------------------------------------------------------------
// REGISTRATION
// ----------------------------------------------------------------------------
async function registerUser({ email, username, password }) {
  // Password policy: enforce in app code AND tell the user why, rather
  // than relying on a DB constraint that produces an opaque 500 error.
  if (password.length < 10) {
    throw new ValidationError('Password must be at least 10 characters.');
  }
  if (!/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new ValidationError('Password must include an uppercase letter and a number.');
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      `INSERT INTO users (email, username, password_hash, membership_type, credits)
       VALUES ($1, $2, $3, 'free', 0)
       RETURNING id, email, username, membership_type, credits, created_at`,
      [email.toLowerCase().trim(), username.trim(), passwordHash]
    );
    const user = userResult.rows[0];

    // No automatic signup bonus — new accounts start at 0 Training
    // Credits by design, so the first thing a new user sees when they
    // try an AI feature is the prompt to purchase. If you ever want to
    // reintroduce a bonus (e.g. a limited-time promo), grant it the
    // same way every other credit grant works: SELECT * FROM
    // grant_credits($1, $2, 'signup_bonus', NULL, $3) — same atomic
    // ledger function, nothing special-cased.

    await client.query('COMMIT');

    // TODO: enqueue verification email (don't send synchronously inline —
    // use a job queue so registration doesn't block on an email provider)
    return user;
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') { // unique_violation
      if (err.constraint.includes('email')) throw new ValidationError('An account with this email already exists.');
      if (err.constraint.includes('username')) throw new ValidationError('That username is taken.');
    }
    throw err;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------------
// LOGIN
// ----------------------------------------------------------------------------
async function loginUser({ email, password, deviceInfo, ipAddress }) {
  const result = await pool.query(
    `SELECT id, email, username, password_hash, membership_type, credits,
            failed_login_count, locked_until
     FROM users WHERE email = $1`,
    [email.toLowerCase().trim()]
  );

  const user = result.rows[0];
  // Constant-shape response whether the user exists or not, to avoid
  // leaking which emails are registered via response timing/content.
  const genericError = new AuthError('Invalid email or password.');

  if (!user) {
    // Still run a bcrypt compare against a dummy hash so the response
    // time is similar to the "user exists, wrong password" path —
    // otherwise timing reveals whether an email is registered.
    await bcrypt.compare(password, '$2b$12$invalidsaltinvalidsaltinvalidsa');
    throw genericError;
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new AuthError('Account temporarily locked due to repeated failed logins. Try again later.');
  }

  const validPassword = await bcrypt.compare(password, user.password_hash);

  if (!validPassword) {
    const newCount = user.failed_login_count + 1;
    const lockUntil = newCount >= 5
      ? new Date(Date.now() + 15 * 60 * 1000) // 15 min lockout after 5 failures
      : null;
    await pool.query(
      `UPDATE users SET failed_login_count = $1, locked_until = $2 WHERE id = $3`,
      [newCount, lockUntil, user.id]
    );
    throw genericError;
  }

  // Reset failure counter on success
  await pool.query(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`,
    [user.id]
  );

  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken();

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      user.id,
      hashToken(refreshToken),
      deviceInfo || null,
      ipAddress || null,
      new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    ]
  );

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, email: user.email, username: user.username, membership_type: user.membership_type, credits: user.credits },
  };
}

// ----------------------------------------------------------------------------
// REFRESH — exchange a valid refresh token for a new access token.
// Implements rotation: the old refresh token is revoked and a new one
// issued, so a stolen-and-replayed old token is detectable (if the real
// user's next refresh fails because their token was already rotated by
// an attacker, that's a signal worth alerting on).
// ----------------------------------------------------------------------------
async function refreshAccessToken({ refreshToken, deviceInfo, ipAddress }) {
  const tokenHash = hashToken(refreshToken);

  const result = await pool.query(
    `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
            u.email, u.membership_type
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1`,
    [tokenHash]
  );

  const tokenRow = result.rows[0];
  if (!tokenRow || tokenRow.revoked_at || new Date(tokenRow.expires_at) < new Date()) {
    throw new AuthError('Refresh token invalid or expired. Please log in again.');
  }

  // Rotate: revoke the used token, issue a new one
  await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [tokenRow.id]);

  const newRefreshToken = generateRefreshToken();
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tokenRow.user_id, hashToken(newRefreshToken), deviceInfo || null, ipAddress || null,
     new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)]
  );

  const accessToken = generateAccessToken({ id: tokenRow.user_id, email: tokenRow.email, membership_type: tokenRow.membership_type });

  return { accessToken, refreshToken: newRefreshToken };
}

async function logoutUser({ refreshToken }) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`,
    [hashToken(refreshToken)]
  );
}

// ----------------------------------------------------------------------------
// PASSWORD RESET
// ----------------------------------------------------------------------------
async function requestPasswordReset({ email }) {
  const result = await pool.query(`SELECT id FROM users WHERE email = $1`, [email.toLowerCase().trim()]);
  const user = result.rows[0];

  // Always return success regardless of whether the email exists —
  // otherwise this endpoint becomes an account-enumeration oracle.
  if (!user) return;

  const resetToken = crypto.randomBytes(32).toString('hex');
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [user.id, hashToken(resetToken), new Date(Date.now() + 60 * 60 * 1000)] // 1 hour
  );

  // TODO: enqueue email with a link containing resetToken in the query string.
  // Never log the raw token server-side.
  return resetToken; // returned here only so the caller's email job can use it
}

async function completePasswordReset({ token, newPassword }) {
  if (newPassword.length < 10) {
    throw new ValidationError('Password must be at least 10 characters.');
  }

  const tokenHash = hashToken(token);
  const result = await pool.query(
    `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  const row = result.rows[0];

  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    throw new AuthError('This reset link is invalid or has expired.');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, row.user_id]);
    await client.query(`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [row.id]);
    // Revoke all existing refresh tokens — a password reset should log
    // out every other session, including an attacker's if this reset
    // was triggered because of a compromised account.
    await client.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ----------------------------------------------------------------------------
// Error types — distinguished so the API layer can map to correct HTTP codes
// ----------------------------------------------------------------------------
class ValidationError extends Error { constructor(msg) { super(msg); this.name = 'ValidationError'; this.statusCode = 400; } }
class AuthError extends Error { constructor(msg) { super(msg); this.name = 'AuthError'; this.statusCode = 401; } }

module.exports = {
  registerUser, loginUser, refreshAccessToken, logoutUser,
  requestPasswordReset, completePasswordReset,
  generateAccessToken, ValidationError, AuthError,
};
