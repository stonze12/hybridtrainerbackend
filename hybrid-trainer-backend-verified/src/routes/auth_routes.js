// ============================================================================
// AUTH ROUTES — registration, login, token refresh, logout, password reset.
// ============================================================================
const express = require('express');
const router = express.Router();
const {
  registerUser, loginUser, refreshAccessToken, logoutUser,
  requestPasswordReset, completePasswordReset,
  ValidationError, AuthError,
} = require('../auth/auth_service');

function handleAuthError(err, res, next) {
  if (err instanceof ValidationError || err instanceof AuthError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  next(err);
}

router.post('/api/auth/register', async (req, res, next) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) {
    return res.status(400).json({ error: 'email, username, and password are all required.' });
  }
  try {
    const user = await registerUser({ email, username, password });
    res.status(201).json({ user });
  } catch (err) { handleAuthError(err, res, next); }
});

router.post('/api/auth/login', async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required.' });
  }
  try {
    const result = await loginUser({
      email, password,
      deviceInfo: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (err) { handleAuthError(err, res, next); }
});

router.post('/api/auth/refresh', async (req, res, next) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required.' });
  try {
    const result = await refreshAccessToken({
      refreshToken,
      deviceInfo: req.headers['user-agent'],
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (err) { handleAuthError(err, res, next); }
});

router.post('/api/auth/logout', async (req, res, next) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required.' });
  try {
    await logoutUser({ refreshToken });
    res.status(204).send();
  } catch (err) { next(err); }
});

router.post('/api/auth/password-reset/request', async (req, res, next) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email is required.' });
  try {
    await requestPasswordReset({ email });
    res.json({ message: 'If an account with that email exists, a reset link has been sent.' });
  } catch (err) { next(err); }
});

router.post('/api/auth/password-reset/complete', async (req, res, next) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'token and newPassword are required.' });
  }
  try {
    await completePasswordReset({ token, newPassword });
    res.json({ message: 'Password updated. Please log in again.' });
  } catch (err) { handleAuthError(err, res, next); }
});

module.exports = router;
