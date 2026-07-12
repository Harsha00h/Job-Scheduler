# API Reference

Base URL: `http://localhost:4000/api`. Everything except `/auth/*` requires
`Authorization: Bearer <token>` (get one from register or login).

Conventions used throughout: errors come back as
`{ "error": { "code", "message", "details?" } }` with the status you'd expect
(400 validation, 401 auth, 403 insufficient role, 404 for both "doesn't
exist" and "exists but isn't yours" — deliberately the same, so resource ids
don't leak across tenants — and 409 for conflicts). List endpoints take
`?page=&limit=` and return `{ data, page, limit, total }`.

## Auth

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/register` | `name, email, password, org_name?` | creates user + personal org (owner); returns `{ user, token }` |
| POST | `/auth/login` | `email, password` | returns `{ user, token }` |
| GET | `/auth/me` | — | current user |

## Projects & retry policies

| Method | Path | Notes |
|---|---|---|
| GET | `/projects` | projects visible to the caller (with their role) |
| POST | `/projects` | `name, description?` — requires org owner/admin |
| GET/DELETE | `/projects/:id` | delete requires owner/admin |
| GET | `/projects/:id/retry-policies` | |
| POST | `/projects/:id/retry-policies` | `name, strategy (fixed\|linear\|exponential), base_delay_ms?, max_delay_ms?, max_attempts?` |
| GET | `/projects/:id/dlq` | unreplayed dead-letter entries (paginated) |
| GET | `/projects/:id/metrics` | status counts, per-minute throughput (1h), failure rate, avg/p95 duration, worker health |
| GET | `/projects/:id/failure-summary` | summary of the last 24h of failures — AI-generated when `ANTHROPIC_API_KEY` is set, deterministic heuristic otherwise (`source` field says which) |

## Queues

| Method | Path | Notes |
|---|---|---|
| GET | `/projects/:projectId/queues` | includes live `pending_jobs` / `active_jobs` counts |
| POST | `/projects/:projectId/queues` | `name, priority?, max_concurrency?, timeout_ms?, retry_policy_id?, rate_limit_per_minute?` (owner/admin) |
| GET/PATCH/DELETE | `/queues/:id` | PATCH accepts any queue field (owner/admin) |
| POST | `/queues/:id/pause` · `/queues/:id/resume` | paused queues are never claimed from |
| GET | `/queues/:id/stats` | counts by status + last-hour completions/failures/avg duration |

## Jobs

| Method | Path | Notes |
|---|---|---|
| POST | `/queues/:id/jobs` | `type, payload?, priority?, run_at? \| delay_ms?, max_attempts?, idempotency_key?, depends_on?` — `depends_on` is an array of job ids that must complete first (workflow dependencies); duplicate idempotency key returns the original job with `deduplicated: true` (200 instead of 201) |
| POST | `/queues/:id/jobs/batch` | `{ jobs: [ ...same fields ] }` (max 1000) → `{ batch_id, job_ids }` |
| GET | `/batches/:batchId` | status counts for the batch |
| GET | `/queues/:id/jobs` | filters: `status` (comma-separated), `type`, `batch_id`; paginated |
| GET | `/jobs/:id` | full detail: job + executions (retry history, per-attempt worker/duration/error/result) + logs |
| POST | `/jobs/:id/cancel` | only while `queued`/`scheduled` (409 otherwise) |
| POST | `/jobs/:id/retry` | requeue a `dead`/`cancelled` job, resets attempts |
| POST | `/dlq/:id/replay` | replay by DLQ entry id; marks the entry replayed |

## Schedules (recurring / cron)

| Method | Path | Notes |
|---|---|---|
| GET | `/queues/:id/schedules` | |
| POST | `/queues/:id/schedules` | `name, cron_expression, job_type, payload?` — cron validated on write, `next_run_at` precomputed |
| PATCH | `/schedules/:id` | `is_active?, cron_expression?` |

## Workers (read-only)

| Method | Path | Notes |
|---|---|---|
| GET | `/workers` | fleet with status + live active job counts |
| GET | `/workers/:id` | includes last 60 heartbeats |

## Example

```bash
TOKEN=$(curl -s -X POST :4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"password123"}' | jq -r .token)

# enqueue a delayed job with dedupe
curl -s -X POST :4000/api/queues/$QUEUE/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"email.send","payload":{"to":"a@b.co"},"delay_ms":5000,"idempotency_key":"welcome-a@b.co"}'

# a workflow: report generation runs only after the export job completes
curl -s -X POST :4000/api/queues/$QUEUE/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"type\":\"report.generate\",\"depends_on\":[\"$EXPORT_JOB_ID\"]}"
```

## WebSocket live updates

`GET /ws?token=<jwt>` upgrades to a WebSocket. The server pushes one JSON
message per job status transition:

```json
{ "type": "job.completed", "job_id": "…", "queue_id": "…", "status": "completed" }
```

Types: `job.created`, `job.running`, `job.completed`, `job.dead`,
`job.cancelled`. The dashboard uses these to refresh instantly, with a slow
poll as fallback.
