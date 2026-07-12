const express = require('express');
const { query, withTransaction } = require('../db');
const { jobAccess } = require('../services/access');
const { cancelDependents } = require('../services/jobs');
const { canTransition } = require('../lib/lifecycle');
const { ApiError } = require('../lib/errors');
const { notifyJobReady } = require('../lib/events');

const router = express.Router();

// full job detail: executions (retry history) + logs
router.get('/jobs/:id', async (req, res, next) => {
  try {
    const job = await jobAccess(req.user.id, req.params.id);
    const [executions, logs] = await Promise.all([
      query(
        `SELECT e.*, w.name AS worker_name FROM job_executions e
         LEFT JOIN workers w ON w.id = e.worker_id
         WHERE e.job_id = $1 ORDER BY e.attempt`,
        [req.params.id]
      ),
      query('SELECT * FROM job_logs WHERE job_id = $1 ORDER BY created_at LIMIT 500', [req.params.id]),
    ]);
    delete job.role;
    res.json({ ...job, executions: executions.rows, logs: logs.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/jobs/:id/cancel', async (req, res, next) => {
  try {
    const job = await jobAccess(req.user.id, req.params.id);
    if (!canTransition(job.status, 'cancelled')) {
      throw ApiError.conflict(`Cannot cancel a job in status '${job.status}'`);
    }
    // status re-checked in the WHERE clause: a worker may have claimed the
    // job between our read and this write.
    const { rows } = await query(
      `UPDATE jobs SET status = 'cancelled', updated_at = now()
       WHERE id = $1 AND status IN ('queued','scheduled') RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) throw ApiError.conflict('Job was claimed before it could be cancelled');
    await cancelDependents(req.params.id); // dependents can never run now
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// manual retry of a dead/cancelled job: reset attempts and requeue
router.post('/jobs/:id/retry', async (req, res, next) => {
  try {
    const job = await jobAccess(req.user.id, req.params.id);
    if (!canTransition(job.status, 'queued')) {
      throw ApiError.conflict(`Cannot retry a job in status '${job.status}'`);
    }
    const updated = await withTransaction(async (tx) => {
      const { rows } = await tx.query(
        `UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(),
                         last_error = NULL, claimed_by = NULL, updated_at = now()
         WHERE id = $1 AND status IN ('dead','cancelled') RETURNING *`,
        [req.params.id]
      );
      if (!rows.length) throw ApiError.conflict('Job state changed, retry aborted');
      await tx.query(
        'UPDATE dead_letter_jobs SET replayed_at = now() WHERE job_id = $1 AND replayed_at IS NULL',
        [req.params.id]
      );
      await notifyJobReady(tx, rows[0].queue_id);
      return rows[0];
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DLQ replay by DLQ entry id (same effect as retrying the underlying job)
router.post('/dlq/:id/replay', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT d.job_id FROM dead_letter_jobs d
       JOIN queues q ON q.id = d.queue_id
       JOIN projects p ON p.id = q.project_id
       JOIN organization_members m ON m.org_id = p.org_id AND m.user_id = $1
       WHERE d.id = $2 AND d.replayed_at IS NULL`,
      [req.user.id, req.params.id]
    );
    if (!rows.length) throw ApiError.notFound('DLQ entry');
    const jobId = rows[0].job_id;
    const updated = await withTransaction(async (tx) => {
      const r = await tx.query(
        `UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(),
                         last_error = NULL, claimed_by = NULL, updated_at = now()
         WHERE id = $1 AND status = 'dead' RETURNING *`,
        [jobId]
      );
      if (!r.rows.length) throw ApiError.conflict('Job is no longer in dead state');
      await tx.query('UPDATE dead_letter_jobs SET replayed_at = now() WHERE id = $1', [req.params.id]);
      await notifyJobReady(tx, r.rows[0].queue_id);
      return r.rows[0];
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
