const { ApiError } = require('../lib/errors');
const logger = require('../lib/logger');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  // unique constraint -> conflict, so callers get a meaningful status
  if (err.code === '23505') {
    return res.status(409).json({
      error: { code: 'conflict', message: 'A record with those values already exists' },
    });
  }
  logger.error('unhandled error', { path: req.path, err: err.message, stack: err.stack });
  return res.status(500).json({
    error: { code: 'internal', message: 'Internal server error' },
  });
}

module.exports = { errorHandler };
