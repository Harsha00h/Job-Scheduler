const express = require('express');
const { query } = require('../db');
const { validate, pagination } = require('../lib/validate');
const { projectRole, requireRole } = require('../services/access');
const { summarizeFailures } = require('../services/ai');
const { ApiError } = require('../lib/errors');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.*, m.role FROM projects p
       JOIN organization_members m ON m.org_id = p.org_id
       WHERE m.user_id = $1 ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const body = validate(req.body, {
      name: { required: true, type: 'string' },
      description: { type: 'string' },
    });
    // create in the caller's first owned/admin org
    const { rows: orgs } = await query(
      `SELECT org_id FROM organization_members
       WHERE user_id = $1 AND role IN ('owner','admin') ORDER BY created_at LIMIT 1`,
      [req.user.id]
    );
    if (!orgs.length) throw ApiError.forbidden('You must be an org owner or admin to create projects');
    const { rows } = await query(
      'INSERT INTO projects (org_id, name, description) VALUES ($1, $2, $3) RETURNING *',
      [orgs[0].org_id, body.name, body.description || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    await projectRole(req.user.id, req.params.id);
    const { rows } = await query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const role = await projectRole(req.user.id, req.params.id);
    requireRole(role, ['owner', 'admin']);
    await query('DELETE FROM projects WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ---- retry policies (project-scoped) ----

router.get('/:id/retry-policies', async (req, res, next) => {
  try {
    await projectRole(req.user.id, req.params.id);
    const { rows } = await query(
      'SELECT * FROM retry_policies WHERE project_id = $1 ORDER BY created_at',
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/retry-policies', async (req, res, next) => {
  try {
    await projectRole(req.user.id, req.params.id);
    const body = validate(req.body, {
      name: { required: true, type: 'string' },
      strategy: { required: true, type: 'string', enum: ['fixed', 'linear', 'exponential'] },
      base_delay_ms: { type: 'number', min: 0, default: 1000 },
      max_delay_ms: { type: 'number', min: 0, default: 3600000 },
      max_attempts: { type: 'number', min: 1, max: 50, default: 3 },
    });
    const { rows } = await query(
      `INSERT INTO retry_policies (project_id, name, strategy, base_delay_ms, max_delay_ms, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.id, body.name, body.strategy, body.base_delay_ms, body.max_delay_ms, body.max_attempts]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ---- dead letter queue (project-scoped view) ----

router.get('/:id/dlq', async (req, res, next) => {
  try {
    await projectRole(req.user.id, req.params.id);
    const { page, limit, offset } = pagination(req.query);
    const { rows } = await query(
      `SELECT d.*, j.type, j.payload, q.name AS queue_name
       FROM dead_letter_jobs d
       JOIN jobs j ON j.id = d.job_id
       JOIN queues q ON q.id = d.queue_id
       WHERE q.project_id = $1 AND d.replayed_at IS NULL
       ORDER BY d.failed_at DESC LIMIT $2 OFFSET $3`,
      [req.params.id, limit, offset]
    );
    const { rows: count } = await query(
      `SELECT count(*)::int AS total FROM dead_letter_jobs d
       JOIN queues q ON q.id = d.queue_id
       WHERE q.project_id = $1 AND d.replayed_at IS NULL`,
      [req.params.id]
    );
    res.json({ data: rows, page, limit, total: count[0].total });
  } catch (err) {
    next(err);
  }
});

// AI-generated (or heuristic, without an API key) summary of recent failures
router.get('/:id/failure-summary', async (req, res, next) => {
  try {
    await projectRole(req.user.id, req.params.id);
    res.json(await summarizeFailures(req.params.id));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
