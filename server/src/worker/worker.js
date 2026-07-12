const os = require('os');
const { Client } = require('pg');
const config = require('../config');
const logger = require('../lib/logger');
const { query, pool } = require('../db');
const { claimJobs } = require('./claim');
const handlers = require('./handlers');
const { computeBackoffMs } = require('../lib/backoff');
const { queueWithPolicy, cancelDependents } = require('../services/jobs');
const { emitJobEvent, JOB_READY_CHANNEL } = require('../lib/events');

// Default retry behaviour when a queue has no retry policy attached.
const DEFAULT_POLICY = { strategy: 'exponential', base_delay_ms: 1000, max_delay_ms: 300000 };

class TimeoutError extends Error {}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class Worker {
  constructor(opts = {}) {
    this.concurrency = opts.concurrency || config.workerConcurrency;
    this.pollIntervalMs = opts.pollIntervalMs || config.workerPollIntervalMs;
    this.active = new Map(); // jobId -> promise
    this.shuttingDown = false;
    this.queueCache = new Map(); // queueId -> { config, at }
  }

  async register() {
    const name = `worker-${os.hostname()}-${process.pid}`;
    const { rows } = await query(
      `INSERT INTO workers (name, hostname, pid, max_concurrency)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [name, os.hostname(), process.pid, this.concurrency]
    );
    this.id = rows[0].id;
    this.name = name;
    logger.info('worker registered', { worker: name, id: this.id, concurrency: this.concurrency });
  }

  start() {
    this.pollTimer = setInterval(() => this.poll().catch((e) => logger.error('poll failed', { err: e.message })), this.pollIntervalMs);
    this.heartbeatTimer = setInterval(() => this.heartbeat().catch((e) => logger.error('heartbeat failed', { err: e.message })), config.heartbeatIntervalMs);
    this.startListener().catch((e) => logger.warn('event listener unavailable, polling only', { err: e.message }));
    this.poll().catch(() => {});
  }

  // Event-driven execution: LISTEN on Postgres so new work is claimed
  // immediately instead of waiting for the next poll tick. Polling stays on
  // as the fallback (missed notifications, delayed/retry jobs coming due).
  async startListener() {
    this.listener = new Client({ connectionString: config.databaseUrl });
    await this.listener.connect();
    await this.listener.query(`LISTEN ${JOB_READY_CHANNEL}`);
    this.listener.on('notification', () => {
      this.poll().catch(() => {});
    });
    this.listener.on('error', (err) => logger.warn('listener error', { err: err.message }));
  }

  async heartbeat() {
    if (this.shuttingDown) return;
    // also flips status back to online in case the reaper marked us dead
    // during a long GC pause / laptop sleep
    await query(
      `UPDATE workers SET last_heartbeat_at = now(), status = 'online' WHERE id = $1`,
      [this.id]
    );
    await query('INSERT INTO worker_heartbeats (worker_id, active_jobs) VALUES ($1, $2)', [
      this.id,
      this.active.size,
    ]);
  }

  async poll() {
    if (this.shuttingDown) return;
    const free = this.concurrency - this.active.size;
    if (free <= 0) return;
    const jobs = await claimJobs(this.id, free);
    for (const job of jobs) {
      const promise = this.run(job)
        .catch((err) => logger.error('job runner crashed', { job: job.id, err: err.message }))
        .finally(() => this.active.delete(job.id));
      this.active.set(job.id, promise);
    }
  }

  async queueConfig(queueId) {
    const cached = this.queueCache.get(queueId);
    if (cached && Date.now() - cached.at < 10000) return cached.config;
    const cfg = await queueWithPolicy(queueId);
    this.queueCache.set(queueId, { config: cfg, at: Date.now() });
    return cfg;
  }

  async run(job) {
    const attempt = job.attempts + 1;
    // Guarded transition claimed -> running. If the reaper requeued this job
    // in the meantime (zero rows updated), someone else owns it now - drop it.
    const { rows: started } = await query(
      `UPDATE jobs SET status = 'running', attempts = $2, updated_at = now()
       WHERE id = $1 AND status = 'claimed' AND claimed_by = $3
       RETURNING id`,
      [job.id, attempt, this.id]
    );
    if (!started.length) return;

    const { rows: execRows } = await query(
      `INSERT INTO job_executions (job_id, worker_id, attempt) VALUES ($1, $2, $3)
       RETURNING id, started_at`,
      [job.id, this.id, attempt]
    );
    const exec = execRows[0];
    await emitJobEvent({ query }, { type: 'job.running', job_id: job.id, queue_id: job.queue_id, status: 'running' }).catch(() => {});
    const log = (level, message) =>
      query('INSERT INTO job_logs (job_id, execution_id, level, message) VALUES ($1, $2, $3, $4)', [
        job.id,
        exec.id,
        level,
        message,
      ]).catch(() => {});

    const queue = await this.queueConfig(job.queue_id);
    const handler = handlers[job.type];
    logger.info('job started', { job: job.id, type: job.type, attempt });

    try {
      if (!handler) throw new Error(`no handler registered for job type '${job.type}'`);
      const result = await withTimeout(handler(job.payload, { log }), queue.timeout_ms);
      await this.succeed(job, exec, result);
    } catch (err) {
      await this.fail(job, exec, queue, attempt, err);
    }
  }

  async succeed(job, exec, result) {
    await query(
      `UPDATE job_executions SET status = 'succeeded', finished_at = now(),
              duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000, result = $2
       WHERE id = $1`,
      [exec.id, JSON.stringify(result ?? null)]
    );
    // claimed_by guard: if we lost the job to the reaper mid-run, the new
    // owner's outcome wins and ours is a no-op
    await query(
      `UPDATE jobs SET status = 'completed', completed_at = now(), updated_at = now(), last_error = NULL
       WHERE id = $1 AND status = 'running' AND claimed_by = $2`,
      [job.id, this.id]
    );
    await emitJobEvent({ query }, { type: 'job.completed', job_id: job.id, queue_id: job.queue_id, status: 'completed' }).catch(() => {});
    logger.info('job completed', { job: job.id, type: job.type });
  }

  async fail(job, exec, queue, attempt, err) {
    const timedOut = err instanceof TimeoutError;
    await query(
      `UPDATE job_executions SET status = $2, finished_at = now(),
              duration_ms = EXTRACT(EPOCH FROM (now() - started_at)) * 1000, error = $3
       WHERE id = $1`,
      [exec.id, timedOut ? 'timed_out' : 'failed', err.message]
    );

    if (attempt >= job.max_attempts) {
      // permanent failure -> dead + DLQ entry
      const { rowCount } = await query(
        `UPDATE jobs SET status = 'dead', last_error = $2, updated_at = now()
         WHERE id = $1 AND status = 'running' AND claimed_by = $3`,
        [job.id, err.message, this.id]
      );
      if (rowCount) {
        await query(
          `INSERT INTO dead_letter_jobs (job_id, queue_id, reason, attempts)
           VALUES ($1, $2, $3, $4)`,
          [job.id, job.queue_id, err.message, attempt]
        );
        // a dead job can never satisfy its dependents - cancel them
        const cancelled = await cancelDependents(job.id).catch(() => 0);
        if (cancelled) logger.warn('cancelled dependent jobs', { job: job.id, count: cancelled });
        await emitJobEvent({ query }, { type: 'job.dead', job_id: job.id, queue_id: job.queue_id, status: 'dead' }).catch(() => {});
      }
      logger.warn('job moved to DLQ', { job: job.id, type: job.type, attempts: attempt });
    } else {
      const policy = queue.strategy ? queue : DEFAULT_POLICY;
      const delay = computeBackoffMs(policy.strategy, policy.base_delay_ms, policy.max_delay_ms, attempt);
      await query(
        `UPDATE jobs SET status = 'scheduled', run_at = now() + ($2 || ' milliseconds')::interval,
                claimed_by = NULL, last_error = $3, updated_at = now()
         WHERE id = $1 AND status = 'running' AND claimed_by = $4`,
        [job.id, delay, err.message, this.id]
      );
      logger.warn('job failed, retry scheduled', {
        job: job.id,
        type: job.type,
        attempt,
        retry_in_ms: delay,
      });
    }
  }

  // Graceful shutdown: stop claiming, finish in-flight jobs (up to the grace
  // period), release anything unfinished back to the queue, mark offline.
  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    clearInterval(this.pollTimer);
    clearInterval(this.heartbeatTimer);
    if (this.listener) await this.listener.end().catch(() => {});
    logger.info('draining', { worker: this.name, in_flight: this.active.size });
    await query(`UPDATE workers SET status = 'draining' WHERE id = $1`, [this.id]).catch(() => {});

    const grace = new Promise((resolve) => setTimeout(resolve, config.shutdownGraceMs).unref());
    await Promise.race([Promise.allSettled([...this.active.values()]), grace]);

    // anything still claimed/running under our name goes back to the pool
    await query(
      `UPDATE jobs SET status = 'queued', claimed_by = NULL, updated_at = now()
       WHERE claimed_by = $1 AND status IN ('claimed', 'running')`,
      [this.id]
    ).catch(() => {});
    await query(`UPDATE workers SET status = 'offline' WHERE id = $1`, [this.id]).catch(() => {});
    await pool.end().catch(() => {});
    logger.info('worker stopped', { worker: this.name });
  }
}

module.exports = { Worker, withTimeout, TimeoutError };
