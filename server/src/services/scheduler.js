// Background loop that runs inside the API server process:
//  1. enqueues jobs for due cron schedules
//  2. reaps dead workers (stale heartbeat) and requeues their jobs
//
// Both run inside a transaction guarded by a Postgres advisory lock, so
// running multiple API instances never double-enqueues a schedule or
// double-reaps a worker: whichever instance gets the lock does the tick,
// the others skip.
const cronParser = require('cron-parser');
const config = require('../config');
const logger = require('../lib/logger');
const { withTransaction } = require('../db');
const { createJob } = require('./jobs');

const SCHEDULER_LOCK_KEY = 745001; // arbitrary app-wide constant

async function enqueueDueSchedules(tx) {
  // SKIP LOCKED so a slow tick never blocks the next one
  const { rows: due } = await tx.query(
    `SELECT * FROM scheduled_jobs
     WHERE is_active AND next_run_at <= now()
     ORDER BY next_run_at
     LIMIT 100
     FOR UPDATE SKIP LOCKED`
  );
  for (const schedule of due) {
    // idempotency key ties the job to this specific occurrence, so even a
    // crash between insert and next_run_at update can't duplicate the run
    await createJob(
      {
        queueId: schedule.queue_id,
        type: schedule.job_type,
        payload: schedule.payload,
        scheduledJobId: schedule.id,
        idempotencyKey: `cron:${schedule.id}:${new Date(schedule.next_run_at).toISOString()}`,
      },
      tx
    );
    // advance from "now" rather than next_run_at: if the scheduler was down
    // for an hour we run once and resume cadence, not backfill 60 runs
    const next = cronParser.parseExpression(schedule.cron_expression).next().toDate();
    await tx.query(
      'UPDATE scheduled_jobs SET next_run_at = $2, last_enqueued_at = now() WHERE id = $1',
      [schedule.id, next.toISOString()]
    );
    logger.info('cron job enqueued', { schedule: schedule.name, next_run_at: next.toISOString() });
  }
  return due.length;
}

async function reapDeadWorkers(tx) {
  const { rows: dead } = await tx.query(
    `UPDATE workers SET status = 'offline'
     WHERE status <> 'offline' AND last_heartbeat_at < now() - ($1 || ' milliseconds')::interval
     RETURNING id, name`,
    [config.workerExpiryMs]
  );
  for (const worker of dead) {
    // mark in-flight executions as lost, then hand the jobs back to the pool.
    // Attempts are NOT incremented: worker death is not the job's fault.
    // This gives at-least-once semantics (the job may run again).
    await tx.query(
      `UPDATE job_executions SET status = 'lost', finished_at = now(),
              error = 'worker heartbeat expired'
       WHERE worker_id = $1 AND status = 'running'`,
      [worker.id]
    );
    const { rowCount } = await tx.query(
      `UPDATE jobs SET status = 'queued', claimed_by = NULL, updated_at = now()
       WHERE claimed_by = $1 AND status IN ('claimed','running')`,
      [worker.id]
    );
    logger.warn('reaped dead worker', { worker: worker.name, requeued_jobs: rowCount });
  }
  return dead.length;
}

async function tick() {
  try {
    await withTransaction(async (tx) => {
      const { rows } = await tx.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [
        SCHEDULER_LOCK_KEY,
      ]);
      if (!rows[0].locked) return; // another instance holds the tick
      await enqueueDueSchedules(tx);
      await reapDeadWorkers(tx);
    });
  } catch (err) {
    logger.error('scheduler tick failed', { err: err.message });
  }
}

function startScheduler() {
  const timer = setInterval(tick, config.schedulerTickMs);
  timer.unref();
  logger.info('scheduler started', { tick_ms: config.schedulerTickMs });
  return timer;
}

module.exports = { startScheduler, tick, enqueueDueSchedules, reapDeadWorkers };
