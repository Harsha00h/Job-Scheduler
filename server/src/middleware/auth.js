const jwt = require('jsonwebtoken');
const config = require('../config');
const { ApiError } = require('../lib/errors');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(ApiError.unauthorized());
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = { id: payload.sub, email: payload.email };
    return next();
  } catch {
    return next(ApiError.unauthorized('Invalid or expired token'));
  }
}

module.exports = { requireAuth };
