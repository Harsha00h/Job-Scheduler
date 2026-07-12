const express = require('express');
const { query } = require('../db');
const { ApiError } = require('../lib/errors');

const router = express.Router();

// Workers are cluster-wide infrastructure (they serve all queues),
// so any authenticated user can view them.
router.get('/workers', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT w.*,
         count(j.id) FILTER (WHERE j.status IN ('claimed','running'))::int AS active_jobs
       FROM workers w LEFT JOIN jobs j ON j.claimed_by = w.id
       GROUP BY w.id ORDER BY w.started_at DESC LIMIT 100`
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/workers/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM workers WHERE id = $1', [req.params.id]);
    if (!rows.length) throw ApiError.notFound('Worker');
    const { rows: heartbeats } = await query(
      `SELECT active_jobs, created_at FROM worker_heartbeats
       WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 60`,
      [req.params.id]
    );
    res.json({ ...rows[0], heartbeats });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
