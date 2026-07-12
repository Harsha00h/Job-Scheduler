const express = require('express');
const cors = require('cors');
const logger = require('./lib/logger');
const { requireAuth } = require('./middleware/auth');
const { errorHandler } = require('./middleware/error');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// request logging with duration
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });
  next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', requireAuth, require('./routes/projects'));
app.use('/api', requireAuth, require('./routes/queues'));
app.use('/api', requireAuth, require('./routes/jobs'));
app.use('/api', requireAuth, require('./routes/workers'));
app.use('/api', requireAuth, require('./routes/metrics'));

app.use((req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: `No route: ${req.method} ${req.path}` } });
});
app.use(errorHandler);

module.exports = app;
