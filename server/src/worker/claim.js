// Atomic job claiming.
//
// Three-stage CTE:
//   1. ranked    - all claimable jobs with a per-queue rank plus the queue's
//                  current active count and executions started in the last
//                  minute (for rate limiting)
//   2. eligible  - jobs whose per-queue rank fits under both max_concurrency
//                  and rate_limit_per_minute; a job is excluded while any of
//                  its dependencies is not completed
//   3. locked    - FOR UPDATE SKIP LOCKED on the survivors; concurrent
//                  workers lock disjoint sets, so a job can never be claimed
//                  twice. The status re-check defends against races between
//                  stages.
//
// Sharding: with WORKER_SHARD_COUNT > 1, each worker only claims from queues
// hashing to its shard index, partitioning claim contention across worker
// groups.
const { query } = require('../db');
const config = require('../config');

const CLAIM_SQL = `
WITH ranked AS (
  SELECT j.id,
         q.priority AS queue_priority,
         j.priority AS job_priority,
         j.run_at,
         row_number() OVER (
           PARTITION BY j.queue_id ORDER BY j.priority DESC, j.run_at
         ) AS queue_rank,
         q.max_concurrency,
         q.rate_limit_per_minute,
         (SELECT count(*) FROM jobs a
          WHERE a.queue_id = j.queue_id AND a.status IN ('claimed', 'running')) AS active_now,
         (SELECT count(*) FROM job_executions e
          JOIN jobs b ON b.id = e.job_id
          WHERE b.queue_id = j.queue_id
            AND e.started_at > now() - interval '1 minute') AS started_last_minute
  FROM jobs j
  JOIN queues q ON q.id = j.queue_id
  WHERE q.is_paused = false
    AND j.status IN ('queued', 'scheduled')
    AND j.run_at <= now()
    AND ($3::int <= 1 OR abs(hashtext(j.queue_id::text)) % $3 = $4)
    AND NOT EXISTS (
      SELECT 1 FROM job_dependencies d
      JOIN jobs p ON p.id = d.depends_on_job_id
      WHERE d.job_id = j.id AND p.status <> 'completed'
    )
),
eligible AS (
  SELECT id FROM ranked
  WHERE active_now + queue_rank <= max_concurrency
    AND (rate_limit_per_minute IS NULL
         OR active_now + started_last_minute + queue_rank <= rate_limit_per_minute)
  ORDER BY queue_priority DESC, job_priority DESC, run_at
  LIMIT $1
),
locked AS (
  SELECT id FROM jobs
  WHERE id IN (SELECT id FROM eligible)
    AND status IN ('queued', 'scheduled')
  FOR UPDATE SKIP LOCKED
)
UPDATE jobs
SET status = 'claimed', claimed_by = $2, updated_at = now()
FROM locked
WHERE jobs.id = locked.id
RETURNING jobs.*`;

async function claimJobs(workerId, limit, shard) {
  const { rows } = await query(CLAIM_SQL, [
    limit,
    workerId,
    shard ? shard.count : config.shardCount,
    shard ? shard.index : config.shardIndex,
  ]);
  return rows;
}

module.exports = { claimJobs, CLAIM_SQL };
