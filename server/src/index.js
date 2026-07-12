const { Client } = require('pg');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const app = require('./app');
const config = require('./config');
const logger = require('./lib/logger');
const { startScheduler } = require('./services/scheduler');
const { pool } = require('./db');
const { JOB_EVENTS_CHANNEL } = require('./lib/events');

const server = app.listen(config.port, () => {
  logger.info('api server listening', { port: config.port });
});

startScheduler();

// ---- WebSocket live updates ----
// Workers emit job transitions via pg_notify; this relays them to dashboard
// clients so the UI updates instantly instead of waiting for the next poll.
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  try {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    jwt.verify(token, config.jwtSecret);
  } catch {
    socket.close(4401, 'unauthorized');
    return;
  }
  logger.debug('ws client connected', { clients: wss.clients.size });
});

async function startEventRelay() {
  const listener = new Client({ connectionString: config.databaseUrl });
  await listener.connect();
  await listener.query(`LISTEN ${JOB_EVENTS_CHANNEL}`);
  listener.on('notification', (msg) => {
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg.payload);
    }
  });
  listener.on('error', (err) => logger.error('event relay error', { err: err.message }));
  logger.info('websocket event relay started');
  return listener;
}

let relay;
startEventRelay()
  .then((l) => {
    relay = l;
  })
  .catch((err) => logger.warn('event relay unavailable', { err: err.message }));

async function shutdown(signal) {
  logger.info('shutting down', { signal });
  wss.close();
  if (relay) await relay.end().catch(() => {});
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  // hard exit if connections refuse to drain
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
