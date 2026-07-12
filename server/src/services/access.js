// Authorization helpers. Every project-scoped resource is checked by
// walking its FK chain back to organization_members for the caller.
const { query } = require('../db');
const { ApiError } = require('../lib/errors');

// Returns the caller's role in the project's org, or throws 404.
// 404 (not 403) so we don't leak which resource ids exist.
async function projectRole(userId, projectId) {
  const { rows } = await query(
    `SELECT m.role FROM projects p
     JOIN organization_members m ON m.org_id = p.org_id AND m.user_id = $1
     WHERE p.id = $2`,
    [userId, projectId]
  );
  if (!rows.length) throw ApiError.notFound('Project');
  return rows[0].role;
}

async function queueProject(userId, queueId) {
  const { rows } = await query(
    `SELECT q.project_id, m.role FROM queues q
     JOIN projects p ON p.id = q.project_id
     JOIN organization_members m ON m.org_id = p.org_id AND m.user_id = $1
     WHERE q.id = $2`,
    [userId, queueId]
  );
  if (!rows.length) throw ApiError.notFound('Queue');
  return rows[0];
}

async function jobAccess(userId, jobId) {
  const { rows } = await query(
    `SELECT j.*, m.role FROM jobs j
     JOIN queues q ON q.id = j.queue_id
     JOIN projects p ON p.id = q.project_id
     JOIN organization_members m ON m.org_id = p.org_id AND m.user_id = $1
     WHERE j.id = $2`,
    [userId, jobId]
  );
  if (!rows.length) throw ApiError.notFound('Job');
  return rows[0];
}

function requireRole(role, allowed) {
  if (!allowed.includes(role)) throw ApiError.forbidden(`Requires role: ${allowed.join(' or ')}`);
}

module.exports = { projectRole, queueProject, jobAccess, requireRole };
