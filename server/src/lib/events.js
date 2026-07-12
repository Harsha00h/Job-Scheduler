// Event-driven execution via Postgres LISTEN/NOTIFY. The database doubles as
// the event bus, so no extra broker is needed:
//   - 'job_ready'  wakes workers immediately when work becomes claimable
//                  (polling remains as the fallback)
//   - 'job_events' streams job status transitions; the API server relays
//                  them to dashboard clients over WebSocket
const { query } = require('../db');

const JOB_READY_CHANNEL = 'job_ready';
const JOB_EVENTS_CHANNEL = 'job_events';

// q: a pg client (inside a transaction) or the default pool wrapper
function notifyJobReady(q, queueId) {
  return q.query(`SELECT pg_notify($1, $2)`, [JOB_READY_CHANNEL, queueId || '']);
}

function emitJobEvent(q, event) {
  return q.query(`SELECT pg_notify($1, $2)`, [JOB_EVENTS_CHANNEL, JSON.stringify(event)]);
}

module.exports = { notifyJobReady, emitJobEvent, JOB_READY_CHANNEL, JOB_EVENTS_CHANNEL };
