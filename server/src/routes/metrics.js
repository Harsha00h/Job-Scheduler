const express = require('express');
const { query } = require('../db');
const { projectRole } = require('../services/access');

const router = express.Router();

// Dashboard overview for a project: status counts, queue depths,
// per-minute throughput for the last hour, failure rate, worker health.
router.get('/projects/:id/metrics', async (req, res, next) => {
  try {
    await projectRole(req.user.id, req.params.id);
    const projectId = req.params.id;

    const [statusCounts, throughput, failure, workers] = await Promise.all([
      query(
        `SELECT j.status, count(*)::int AS count
         FROM jobs j JOIN queues q ON q.id = j.queue_id
         WHERE q.project_id = $1 GROUP BY j.status`,
        [projectId]
      ),
      query(
        `SELECT date_trunc('minute', e.finished_at) AS minute,
                count(*) FILTER (WHERE e.status = 'succeeded')::int AS succeeded,
                count(*) FILTER (WHERE e.status <> 'succeeded')::int AS failed
         FROM job_executions e
         JOIN jobs j ON j.id = e.job_id
         JOIN queues q ON q.id = j.queue_id
         WHERE q.project_id = $1 AND e.finished_at > now() - interval '60 minutes'
         GROUP BY 1 ORDER BY 1`,
        [projectId]
      ),
      query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE e.status <> 'succeeded')::int AS failed,
                round(avg(e.duration_ms))::int AS avg_duration_ms,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY e.duration_ms)::int AS p95_duration_ms
         FROM job_executions e
         JOIN jobs j ON j.id = e.job_id
         JOIN queues q ON q.id = j.queue_id
         WHERE q.project_id = $1 AND e.finished_at > now() - interval '60 minutes'`,
        [projectId]
      ),
      query(
        `SELECT count(*) FILTER (WHERE status = 'online')::int AS online,
                count(*) FILTER (WHERE status = 'offline')::int AS offline
         FROM workers`
      ),
    ]);

    res.json({
      by_status: Object.fromEntries(statusCounts.rows.map((r) => [r.status, r.count])),
      throughput_per_minute: throughput.rows,
      last_hour: failure.rows[0],
      workers: workers.rows[0],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
