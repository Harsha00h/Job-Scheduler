const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { query, withTransaction } = require('../db');
const { validate } = require('../lib/validate');
const { ApiError } = require('../lib/errors');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

// Registering creates the user plus a personal organization in one
// transaction so a user always has an org to put projects in.
router.post('/register', async (req, res, next) => {
  try {
    const body = validate(req.body, {
      name: { required: true, type: 'string' },
      email: { required: true, type: 'string' },
      password: { required: true, type: 'string' },
      org_name: { type: 'string' },
    });
    if (!/^\S+@\S+\.\S+$/.test(body.email)) throw ApiError.badRequest('Invalid email address');
    if (body.password.length < 8) throw ApiError.badRequest('Password must be at least 8 characters');

    const hash = await bcrypt.hash(body.password, 10);
    const user = await withTransaction(async (tx) => {
      const existing = await tx.query('SELECT 1 FROM users WHERE email = $1', [body.email.toLowerCase()]);
      if (existing.rows.length) throw ApiError.conflict('Email already registered');
      const u = (
        await tx.query(
          'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name',
          [body.email.toLowerCase(), hash, body.name]
        )
      ).rows[0];
      const org = (
        await tx.query('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [
          body.org_name || `${body.name}'s org`,
        ])
      ).rows[0];
      await tx.query(
        "INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')",
        [org.id, u.id]
      );
      return u;
    });
    res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const body = validate(req.body, {
      email: { required: true, type: 'string' },
      password: { required: true, type: 'string' },
    });
    const { rows } = await query('SELECT * FROM users WHERE email = $1', [body.email.toLowerCase()]);
    const user = rows[0];
    const ok = user && (await bcrypt.compare(body.password, user.password_hash));
    if (!ok) throw ApiError.unauthorized('Invalid email or password');
    res.json({
      user: { id: user.id, email: user.email, name: user.name },
      token: signToken(user),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT id, email, name, created_at FROM users WHERE id = $1', [
      req.user.id,
    ]);
    if (!rows.length) throw ApiError.unauthorized();
    res.json({ user: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
