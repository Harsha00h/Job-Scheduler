const express = require('express');
const cronParser = require('cron-parser');
const { query } = require('../db');
const { validate, pagination } = require('../lib/validate');
const { projectRole, queueProject, requireRole } = require('../services/access');
const { createJob } = require('../services/jobs');
const { ApiError } = require('../lib/errors');
const crypto = require('crypto');

const router = express.Router();

const QUEUE_FIELDS = {
  name: { type: 'string' },
  priority: { type: 'number', min: -100, max: 100 },
  max_concurrency: { type: 'number', min: 1, max: 1000 },
  timeout_ms: { type: 'number', min: 100 },
  retry_policy_id: { type: 'string' },
  is_paused: { type: 'boolean' },
  rate_limit_per_minute: { type: 'number', min: 1 },
};

router.get('/projects/:projectId/queues', async (req, res, next) => {
  try {
    await projectRole(req.user.id, req.params.projectId);
    const { rows } = await query(
      `SELECT q.*,
         count(j.id) FILTER (WHERE j.status IN ('queued','scheduled'))::int AS pending_jobs,
         count(j.id) FILTER (WHERE j.status IN ('claimed','running'))::int AS active_jobs
       FROM queues q LEFT JOIN jobs j ON j.queue_id = q.id
       WHERE q.project_id = $1
       GROUP BY q.id ORDER BY q.priority DESC, q.name`,
      [req.params.projectId]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/projects/:projectId/queues', async (req, res, next) => {
  try {
    const role = await projectRole(req.user.id, req.params.projectId);
    requireRole(role, ['owner', 'admin']);
    const body = validate(req.body, { ...QUEUE_FIELDS, name: { required: true, type: 'string' } });
    const { rows } = await query(
      `INSERT INTO queues (project_id, name, priority, max_concurrency, timeout_ms, retry_policy_id, rate_limit_per_minute)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        req.params.projectId,
        body.name,
        body.priority ?? 0,
        body.max_concurrency ?? 5,
        body.timeout_ms ?? 60000,
        body.retry_policy_id || null,
        body.rate_limit_per_minute ?? null,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/queues/:id', async (req, res, next) => {
  try {
    await queueProject(req.user.id, req.params.id);
    const { rows } = await query('SELECT * FROM queues WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/queues/:id', async (req, res, next) => {
  try {
    const { role } = await queueProject(req.user.id, req.params.id);
    requireRole(role, ['owner', 'admin']);
    const body = validate(req.body, QUEUE_FIELDS);
    const keys = Object.keys(body);
    if (!keys.length) throw ApiError.badRequest('No updatable fields provided');
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await query(
      `UPDATE queues SET ${sets} WHERE id = $1 RETURNING *`,
      [req.params.id, ...keys.map((k) => body[k])]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/queues/:id', async (req, res, next) => {
  try {
    const { role } = await queueProject(req.user.id, req.params.id);
    requireRole(role, ['owner', 'admin']);
    await query('DELETE FROM queues WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

for (const action of ['pause', 'resume']) {
  router.post(`/queues/:id/${action}`, async (req, res, next) => {
    try {
      const { role } = await queueProject(req.user.id, req.params.id);
      requireRole(role, ['owner', 'admin']);
      const { rows } = await query('UPDATE queues SET is_paused = $2 WHERE id = $1 RETURNING *', [
        req.params.id,
        action === 'pause',
      ]);
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });
}

router.get('/queues/:id/stats', async (req, res, next) => {
  try {
    await queueProject(req.user.id, req.params.id);
    const [statuses, timing] = await Promise.all([
      query(
        `SELECT status, count(*)::int AS count FROM jobs WHERE queue_id = $1 GROUP BY status`,
        [req.params.id]
      ),
      query(
        `SELECT count(*)::int AS completed_last_hour,
                round(avg(e.duration_ms))::int AS avg_duration_ms,
                count(*) FILTER (WHERE e.status <> 'succeeded')::int AS failed_last_hour
         FROM job_executions e JOIN jobs j ON j.id = e.job_id
         WHERE j.queue_id = $1 AND e.finished_at > now() - interval '1 hour'`,
        [req.params.id]
      ),
    ]);
    const byStatus = Object.fromEntries(statuses.rows.map((r) => [r.status, r.count]));
    res.json({ by_status: byStatus, last_hour: timing.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ---- job creation ----

const JOB_FIELDS = {
  type: { required: true, type: 'string' },
  payload: { type: 'object' },
  priority: { type: 'number', min: -100, max: 100 },
  run_at: { type: 'string' },
  delay_ms: { type: 'number', min: 0 },
  max_attempts: { type: 'number', min: 1, max: 50 },
  idempotency_key: { type: 'string' },
  depends_on: { type: 'array' },
};

function resolveRunAt(body) {
  if (body.run_at) return body.run_at;
  if (body.delay_ms) return new Date(Date.now() + body.delay_ms).toISOString();
  return undefined;
}

router.post('/queues/:id/jobs', async (req, res, next) => {
  try {
    await queueProject(req.user.id, req.params.id);
    const body = validate(req.body, JOB_FIELDS);
    const { job, deduplicated } = await createJob({
      queueId: req.params.id,
      type: body.type,
      payload: body.payload,
      priority: body.priority,
      runAt: resolveRunAt(body),
      maxAttempts: body.max_attempts,
      idempotencyKey: body.idempotency_key,
      dependsOn: body.depends_on,
    });
    res.status(deduplicated ? 200 : 201).json({ ...job, deduplicated });
  } catch (err) {
    next(err);
  }
});

// batch submission: all jobs share a batch_id for group tracking
router.post('/queues/:id/jobs/batch', async (req, res, next) => {
  try {
    await queueProject(req.user.id, req.params.id);
    const jobs = req.body && req.body.jobs;
    if (!Array.isArray(jobs) || !jobs.length) throw ApiError.badRequest('jobs must be a non-empty array');
    if (jobs.length > 1000) throw ApiError.badRequest('Batch size limit is 1000');
    const batchId = crypto.randomUUID();
    const created = [];
    for (const spec of jobs) {
      const body = validate(spec, JOB_FIELDS);
      const { job } = await createJob({
        queueId: req.params.id,
        type: body.type,
        payload: body.payload,
        priority: body.priority,
        runAt: resolveRunAt(body),
        maxAttempts: body.max_attempts,
        idempotencyKey: body.idempotency_key,
        batchId,
      });
      created.push(job.id);
    }
    res.status(201).json({ batch_id: batchId, job_ids: created, count: created.length });
  } catch (err) {
    next(err);
  }
});

router.get('/batches/:batchId', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT j.status, count(*)::int AS count FROM jobs j
       JOIN queues q ON q.id = j.queue_id
       JOIN projects p ON p.id = q.project_id
       JOIN organization_members m ON m.org_id = p.org_id AND m.user_id = $1
       WHERE j.batch_id = $2 GROUP BY j.status`,
      [req.user.id, req.params.batchId]
    );
    if (!rows.length) throw ApiError.notFound('Batch');
    res.json({
      batch_id: req.params.batchId,
      by_status: Object.fromEntries(rows.map((r) => [r.status, r.count])),
    });
  } catch (err) {
    next(err);
  }
});

// ---- job listing (with filters + pagination) ----

router.get('/queues/:id/jobs', async (req, res, next) => {
  try {
    await queueProject(req.user.id, req.params.id);
    const { page, limit, offset } = pagination(req.query);
    const conditions = ['queue_id = $1'];
    const params = [req.params.id];
    if (req.query.status) {
      params.push(req.query.status.split(','));
      conditions.push(`status = ANY($${params.length})`);
    }
    if (req.query.type) {
      params.push(req.query.type);
      conditions.push(`type = $${params.length}`);
    }
    if (req.query.batch_id) {
      params.push(req.query.batch_id);
      conditions.push(`batch_id = $${params.length}`);
    }
    const where = conditions.join(' AND ');
    const [list, count] = await Promise.all([
      query(
        `SELECT * FROM jobs WHERE ${where}
         ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      query(`SELECT count(*)::int AS total FROM jobs WHERE ${where}`, params),
    ]);
    res.json({ data: list.rows, page, limit, total: count.rows[0].total });
  } catch (err) {
    next(err);
  }
});

// ---- recurring (cron) schedules ----

router.get('/queues/:id/schedules', async (req, res, next) => {
  try {
    await queueProject(req.user.id, req.params.id);
    const { rows } = await query(
      'SELECT * FROM scheduled_jobs WHERE queue_id = $1 ORDER BY created_at',
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/queues/:id/schedules', async (req, res, next) => {
  try {
    await queueProject(req.user.id, req.params.id);
    const body = validate(req.body, {
      name: { required: true, type: 'string' },
      cron_expression: { required: true, type: 'string' },
      job_type: { required: true, type: 'string' },
      payload: { type: 'object' },
    });
    let next_run_at;
    try {
      next_run_at = cronParser.parseExpression(body.cron_expression).next().toDate();
    } catch {
      throw ApiError.badRequest(`Invalid cron expression: ${body.cron_expression}`);
    }
    const { rows } = await query(
      `INSERT INTO scheduled_jobs (queue_id, name, cron_expression, job_type, payload, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, body.name, body.cron_expression, body.job_type,
       JSON.stringify(body.payload || {}), next_run_at.toISOString()]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.patch('/schedules/:id', async (req, res, next) => {
  try {
    const { rows: owned } = await query(
      `SELECT s.id FROM scheduled_jobs s
       JOIN queues q ON q.id = s.queue_id
       JOIN projects p ON p.id = q.project_id
       JOIN organization_members m ON m.org_id = p.org_id AND m.user_id = $1
       WHERE s.id = $2`,
      [req.user.id, req.params.id]
    );
    if (!owned.length) throw ApiError.notFound('Schedule');
    const body = validate(req.body, { is_active: { type: 'boolean' }, cron_expression: { type: 'string' } });
    if (body.cron_expression) {
      let next_run_at;
      try {
        next_run_at = cronParser.parseExpression(body.cron_expression).next().toDate();
      } catch {
        throw ApiError.badRequest(`Invalid cron expression: ${body.cron_expression}`);
      }
      await query(
        'UPDATE scheduled_jobs SET cron_expression = $2, next_run_at = $3 WHERE id = $1',
        [req.params.id, body.cron_expression, next_run_at.toISOString()]
      );
    }
    if (body.is_active !== undefined) {
      await query('UPDATE scheduled_jobs SET is_active = $2 WHERE id = $1', [req.params.id, body.is_active]);
    }
    const { rows } = await query('SELECT * FROM scheduled_jobs WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
