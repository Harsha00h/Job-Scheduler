# Schema & ER diagram

```mermaid
erDiagram
    users ||--o{ organization_members : "belongs to"
    organizations ||--o{ organization_members : has
    organizations ||--o{ projects : owns
    projects ||--o{ queues : owns
    projects ||--o{ retry_policies : defines
    retry_policies |o--o{ queues : "applied to"
    queues ||--o{ jobs : contains
    queues ||--o{ scheduled_jobs : "cron schedules"
    jobs ||--o{ job_dependencies : "depends on"
    scheduled_jobs |o--o{ jobs : spawns
    jobs ||--o{ job_executions : "attempt history"
    jobs ||--o{ job_logs : logs
    job_executions |o--o{ job_logs : "scoped to"
    workers ||--o{ job_executions : ran
    workers |o--o{ jobs : "claimed by"
    workers ||--o{ worker_heartbeats : emits
    jobs ||--o{ dead_letter_jobs : "on permanent failure"

    users { uuid id PK  text email UK  text password_hash  text name }
    organizations { uuid id PK  text name }
    organization_members { uuid org_id PK,FK  uuid user_id PK,FK  text role }
    projects { uuid id PK  uuid org_id FK  text name }
    retry_policies { uuid id PK  uuid project_id FK  text strategy  int base_delay_ms  int max_delay_ms  int max_attempts }
    queues { uuid id PK  uuid project_id FK  text name  int priority  int max_concurrency  int rate_limit_per_minute  int timeout_ms  uuid retry_policy_id FK  bool is_paused }
    job_dependencies { uuid job_id PK,FK  uuid depends_on_job_id PK,FK }
    scheduled_jobs { uuid id PK  uuid queue_id FK  text cron_expression  text job_type  jsonb payload  timestamptz next_run_at  bool is_active }
    jobs { uuid id PK  uuid queue_id FK  uuid batch_id  text type  jsonb payload  text status  int priority  timestamptz run_at  int attempts  int max_attempts  text idempotency_key  uuid claimed_by FK }
    job_executions { uuid id PK  uuid job_id FK  uuid worker_id FK  int attempt  text status  timestamptz started_at  timestamptz finished_at  int duration_ms  text error  jsonb result }
    job_logs { bigint id PK  uuid job_id FK  uuid execution_id FK  text level  text message }
    workers { uuid id PK  text name  text status  int max_concurrency  timestamptz last_heartbeat_at }
    worker_heartbeats { bigint id PK  uuid worker_id FK  int active_jobs  timestamptz created_at }
    dead_letter_jobs { uuid id PK  uuid job_id FK  uuid queue_id FK  text reason  int attempts  timestamptz replayed_at }
```

*(Viewing this outside GitHub? A rendered copy: [images/er-diagram.png](images/er-diagram.png))*

The full DDL is one file: [schema.sql](../server/src/db/schema.sql). Below is
the reasoning behind the choices, which I think matters more than the
diagram.

## Keys

Entity tables use UUID primary keys (`gen_random_uuid()`) so ids can be
generated anywhere without coordination and never collide across
environments. The two append-only, high-volume tables — `job_logs` and
`worker_heartbeats` — use `BIGSERIAL` instead: small, ordered keys index
better, those tables grow fastest, and nothing external ever references their
rows. `organization_members` is a pure join table, so it gets a composite
primary key `(org_id, user_id)` rather than a surrogate id it doesn't need.

## Foreign keys and what deletes do

I split references into two kinds. Ownership chains cascade:
org → project → queue → job → executions/logs, so deleting a project takes
everything under it and can't leave orphans. References that aren't ownership
use `ON DELETE SET NULL` — `jobs.claimed_by`, `queues.retry_policy_id`,
`job_executions.worker_id` — because deleting a worker or a retry policy must
never destroy job history. The rule of thumb I followed: if the parent *owns*
the child, cascade; if the parent is merely *mentioned by* the child, null it
out and keep the row.

## Normalization, and the one place I broke it

The schema is 3NF: retry parameters live once in `retry_policies` and are
shared by queues; execution attempts are rows in `job_executions`, not
columns or arrays on `jobs`. There's one deliberate denormalization:
`max_attempts` (and the `attempts` counter) is copied onto each job at
creation. Two reasons — the worker's hot path can decide "retry or DLQ"
without a join, and editing a retry policy doesn't retroactively change jobs
already in flight, which is the behavior I'd want as an operator.

## Indexes that matter

- `jobs (queue_id, priority DESC, run_at) WHERE status IN ('queued','scheduled')`
  — the claim scan. It's **partial** on purpose: over time almost every job
  is completed or dead, and those rows never enter this index, so the hot
  path stays small no matter how much history accumulates.
- `jobs (queue_id, idempotency_key) UNIQUE WHERE idempotency_key IS NOT NULL`
  — dedupe enforced by the database rather than application logic. Partial,
  so jobs without a key don't pay for it.
- `scheduled_jobs (next_run_at) WHERE is_active` — the scheduler tick only
  ever scans active, due schedules.
- `job_executions (finished_at) WHERE finished_at IS NOT NULL` — the
  throughput and latency metrics all scan by finish time.
- `worker_heartbeats (worker_id, created_at DESC)` — "recent heartbeats for
  worker X", which the worker detail view hits.

## Statuses: TEXT + CHECK, not enums

Adding a state to a CHECK constraint is a cheap swap; evolving a native enum
historically meant an `ALTER TYPE` with locking side effects. There was no
upside to enums that I cared about, so I took the option that's easier to
change later.

## Growth

The claim path is a single index-backed statement and per-job reads are keyed
scans, so the day-one performance story is fine. The tables that grow without
bound are `job_executions`, `job_logs` and `worker_heartbeats`; at real scale
I'd partition jobs/executions by month, archive completed jobs, and prune
heartbeats older than a day — sketched in
[design-decisions.md](design-decisions.md).
