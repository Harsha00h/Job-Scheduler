# Distributed Job Scheduler

A job scheduling platform: a REST API for managing projects, queues and jobs,
plus a fleet of worker processes that claim and execute those jobs reliably —
with retries, backoff, a dead letter queue, cron schedules and a live
dashboard. Built on Node, Express, PostgreSQL and React.

The core idea, and the thing everything else hangs off: **Postgres is the
coordinator, not just the storage.** There's no Redis and no message broker.
Workers claim jobs with `FOR UPDATE SKIP LOCKED`, so two workers can never
run the same job, and the job's state, retry history and results all live in
one transactional store. The reasoning (and the trade-offs I accepted) are in
[docs/design-decisions.md](docs/design-decisions.md).

## What it does

- JWT auth with organizations → projects → queues, and owner/admin/member
  roles on destructive operations
- Queues with priority, per-queue concurrency limits, rate limits, execution
  timeouts, retry policies (fixed / linear / exponential backoff), and
  pause/resume
- Jobs: immediate, delayed (`delay_ms`), scheduled (`run_at`), recurring
  (cron) and batches; idempotency keys deduplicate repeat submissions
- Workflow dependencies: `depends_on` holds a job back until its parents
  complete, and cascade-cancels it if a parent dies
- Workers poll *and* listen (Postgres LISTEN/NOTIFY) so new work is claimed
  immediately; they heartbeat every 5s and drain gracefully on SIGTERM
- A reaper detects dead workers by stale heartbeat and requeues their jobs
- Full history: every attempt is a row in `job_executions` with worker,
  duration, error and result; handlers write to `job_logs`
- Dead letter queue with one-click replay, plus AI-generated failure
  summaries (Claude or Gemini if a key is configured, a heuristic otherwise)
- React dashboard with live updates over WebSocket: overview metrics and
  throughput chart, queue management, job explorer, per-job retry history
  and logs, worker fleet, DLQ

## Running it

You need Node 18+ and PostgreSQL 14+ (or Docker for the database).

```bash
# database — skip if you already run Postgres locally
docker compose up -d postgres

# API server (also runs the cron scheduler and the dead-worker reaper)
cd server
npm install
cp .env.example .env        # adjust DATABASE_URL if yours differs
npm run migrate
npm run seed                # optional: demo user, queues, sample jobs
npm start                   # :4000

# workers — separate terminal(s); run two or three to see jobs distribute
npm run worker

# dashboard — separate terminal
cd ../dashboard
npm install
npm run dev                 # http://localhost:5173, proxies /api to :4000
```

After seeding, log in with `demo@example.com` / `password123`. The seed
includes a cron schedule that fires every minute and a job that always fails,
so within a couple of minutes you'll see completions, retries and a DLQ entry
without doing anything.

Worth trying: `kill -9` a worker while it's running jobs. Within ~15 seconds
the reaper notices the missing heartbeat, requeues its jobs, and another
worker finishes them — the executions tab on the affected job will show a
`lost` attempt.

## Tests

```bash
cd server
createdb scheduler_test     # once
npm test
```

30 tests. The ones I'd point you at first: two workers claiming concurrently
never receive the same job; a failing job walks through retries into the DLQ
and back out via replay; dependency gating and cascade-cancel; rate limits
and concurrency caps enforced inside the claim query; tenant isolation
(someone else's project 404s rather than 403s, so ids don't leak).

## Layout

```
server/
  src/routes/       REST endpoints
  src/services/     job creation, cron scheduler + reaper, access control, AI summaries
  src/worker/       the worker service: claim query, executor, handlers
  src/lib/          backoff math, lifecycle state machine, validation, logger, events
  src/db/           schema.sql, migrate, seed
  tests/
dashboard/          React + Vite
docs/               architecture, ER diagram, API reference, design decisions
```

## Docs

- [Architecture](docs/architecture.md) — the three processes and how a job
  flows through them
- [ER diagram](docs/er-diagram.md) — the schema, with the reasoning for keys,
  indexes and the one denormalization
- [API reference](docs/api.md)
- [Design decisions](docs/design-decisions.md) — the trade-offs, including
  the two known limitations I chose to document rather than hide
