-- Distributed Job Scheduler - relational schema (PostgreSQL)
-- Statuses use CHECK constraints rather than native enums so new states
-- can be added without ALTER TYPE table rewrites/locks.

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

CREATE TABLE IF NOT EXISTS retry_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('fixed', 'linear', 'exponential')),
  base_delay_ms INTEGER NOT NULL DEFAULT 1000 CHECK (base_delay_ms >= 0),
  max_delay_ms INTEGER NOT NULL DEFAULT 3600000 CHECK (max_delay_ms >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS queues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- queue-level priority: higher is claimed first, before job priority
  priority INTEGER NOT NULL DEFAULT 0,
  max_concurrency INTEGER NOT NULL DEFAULT 5 CHECK (max_concurrency >= 1),
  timeout_ms INTEGER NOT NULL DEFAULT 60000 CHECK (timeout_ms >= 100),
  retry_policy_id UUID REFERENCES retry_policies(id) ON DELETE SET NULL,
  is_paused BOOLEAN NOT NULL DEFAULT false,
  -- NULL = unlimited; otherwise max executions started per rolling minute
  rate_limit_per_minute INTEGER CHECK (rate_limit_per_minute IS NULL OR rate_limit_per_minute >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, name)
);
-- for databases created before the column existed
ALTER TABLE queues ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER;

CREATE TABLE IF NOT EXISTS workers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  hostname TEXT,
  pid INTEGER,
  status TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'draining', 'offline')),
  max_concurrency INTEGER NOT NULL DEFAULT 5,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  id BIGSERIAL PRIMARY KEY,
  worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  active_jobs INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_heartbeats_worker_time
  ON worker_heartbeats (worker_id, created_at DESC);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  cron_expression TEXT NOT NULL,
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ NOT NULL,
  last_enqueued_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (queue_id, name)
);
-- partial index: the scheduler tick only ever scans active schedules that are due
CREATE INDEX IF NOT EXISTS idx_scheduled_due
  ON scheduled_jobs (next_run_at) WHERE is_active;

CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_id UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  scheduled_job_id UUID REFERENCES scheduled_jobs(id) ON DELETE SET NULL,
  batch_id UUID,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'scheduled', 'claimed', 'running', 'completed', 'dead', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  idempotency_key TEXT,
  claimed_by UUID REFERENCES workers(id) ON DELETE SET NULL,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- dedupe: at most one job per (queue, idempotency_key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency
  ON jobs (queue_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- the hot path: workers scanning for claimable work. Partial index keeps it
-- small because completed/dead jobs (the vast majority over time) are excluded.
CREATE INDEX IF NOT EXISTS idx_jobs_claimable
  ON jobs (queue_id, priority DESC, run_at) WHERE status IN ('queued', 'scheduled');
CREATE INDEX IF NOT EXISTS idx_jobs_batch
  ON jobs (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_queue_created ON jobs (queue_id, created_at DESC);

-- workflow dependencies: a job is claimable only when every job it depends
-- on has completed. Cancelling/dead-lettering a parent cascades to children.
CREATE TABLE IF NOT EXISTS job_dependencies (
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  depends_on_job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  PRIMARY KEY (job_id, depends_on_job_id)
);
CREATE INDEX IF NOT EXISTS idx_deps_parent ON job_dependencies (depends_on_job_id);

CREATE TABLE IF NOT EXISTS job_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  worker_id UUID REFERENCES workers(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'succeeded', 'failed', 'timed_out', 'lost')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  error TEXT,
  result JSONB
);
CREATE INDEX IF NOT EXISTS idx_executions_job ON job_executions (job_id, attempt);
-- throughput/latency metrics scan by finish time
CREATE INDEX IF NOT EXISTS idx_executions_finished
  ON job_executions (finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  execution_id UUID REFERENCES job_executions(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_logs_job ON job_logs (job_id, created_at);

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  queue_id UUID NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  replayed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_dlq_queue ON dead_letter_jobs (queue_id, failed_at DESC);
