const { query } = require('../db');
const { ApiError } = require('../lib/errors');
const { notifyJobReady, emitJobEvent } = require('../lib/events');

// Resolves the effective retry settings for a queue: an explicit
// max_attempts on the job wins, then the queue's retry policy, then default.
async function queueWithPolicy(queueId, client) {
  const q = client || { query };
  const { rows } = await q.query(
    `SELECT q.*, rp.strategy, rp.base_delay_ms, rp.max_delay_ms, rp.max_attempts AS policy_max_attempts
     FROM queues q LEFT JOIN retry_policies rp ON rp.id = q.retry_policy_id
     WHERE q.id = $1`,
    [queueId]
  );
  return rows[0];
}

// Creates a job. Delayed/scheduled jobs get status 'scheduled' with a
// future run_at; the claim query treats them identically once due.
// Idempotency: ON CONFLICT DO NOTHING + re-select means submitting the
// same (queue, idempotency_key) twice returns the original job.
// Dependencies (opts.dependsOn): parent jobs that must complete before
// this one becomes claimable.
async function createJob(opts, client) {
  const q = client || { query };
  const queue = await queueWithPolicy(opts.queueId, client);
  if (!queue) throw ApiError.notFound('Queue');

  const runAt = opts.runAt ? new Date(opts.runAt) : new Date();
  if (Number.isNaN(runAt.getTime())) throw ApiError.badRequest('Invalid run_at timestamp');
  const status = runAt > new Date() ? 'scheduled' : 'queued';
  const maxAttempts = opts.maxAttempts || queue.policy_max_attempts || 3;

  if (opts.dependsOn && opts.dependsOn.length) {
    // parents must exist and live in the same project as this queue
    const { rows: parents } = await q.query(
      `SELECT j.id FROM jobs j
       JOIN queues pq ON pq.id = j.queue_id
       WHERE j.id = ANY($1) AND pq.project_id = $2`,
      [opts.dependsOn, queue.project_id]
    );
    if (parents.length !== opts.dependsOn.length) {
      throw ApiError.badRequest('depends_on contains unknown jobs or jobs from another project');
    }
  }

  const { rows } = await q.query(
    `INSERT INTO jobs (queue_id, type, payload, status, priority, run_at, max_attempts,
                       idempotency_key, batch_id, scheduled_job_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (queue_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      opts.queueId,
      opts.type,
      JSON.stringify(opts.payload || {}),
      status,
      opts.priority || 0,
      runAt.toISOString(),
      maxAttempts,
      opts.idempotencyKey || null,
      opts.batchId || null,
      opts.scheduledJobId || null,
    ]
  );

  if (!rows.length) {
    const existing = await q.query(
      'SELECT * FROM jobs WHERE queue_id = $1 AND idempotency_key = $2',
      [opts.queueId, opts.idempotencyKey]
    );
    return { job: existing.rows[0], deduplicated: true };
  }

  const job = rows[0];
  if (opts.dependsOn && opts.dependsOn.length) {
    for (const parentId of opts.dependsOn) {
      await q.query(
        'INSERT INTO job_dependencies (job_id, depends_on_job_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [job.id, parentId]
      );
    }
  }

  // wake workers (event-driven path; polling remains the fallback)
  if (status === 'queued') await notifyJobReady(q, job.queue_id);
  await emitJobEvent(q, { type: 'job.created', job_id: job.id, queue_id: job.queue_id, status });

  return { job, deduplicated: false };
}

// Cascade-cancel every pending job that (transitively) depends on this one.
// Called when a job dies or is cancelled: its dependents can never run.
async function cancelDependents(jobId, client) {
  const q = client || { query };
  const { rows } = await q.query(
    `WITH RECURSIVE deps AS (
       SELECT job_id FROM job_dependencies WHERE depends_on_job_id = $1
       UNION
       SELECT d.job_id FROM job_dependencies d JOIN deps ON d.depends_on_job_id = deps.job_id
     )
     UPDATE jobs SET status = 'cancelled',
            last_error = 'cancelled: a dependency failed or was cancelled',
            updated_at = now()
     WHERE id IN (SELECT job_id FROM deps) AND status IN ('queued', 'scheduled')
     RETURNING id, queue_id`,
    [jobId]
  );
  for (const child of rows) {
    await emitJobEvent(q, {
      type: 'job.cancelled',
      job_id: child.id,
      queue_id: child.queue_id,
      status: 'cancelled',
    });
  }
  return rows.length;
}

module.exports = { createJob, queueWithPolicy, cancelDependents };
