# Design decisions and trade-offs

These are the calls I made while building this, roughly in order of how much
they shaped everything else. I've tried to be honest about the downsides of
each choice rather than only listing the upsides.

## Why Postgres is the queue (and there's no Redis or RabbitMQ)

This was the first decision and the biggest one. The assignment is mostly
about reliability and concurrency, and the strongest tool I know for both is
a transactional database. `FOR UPDATE SKIP LOCKED` gives me race-free claims
without workers blocking each other, and it means the job, its retry state,
its execution history and the DLQ all live in one ACID store. With a broker
you always end up with two sources of truth — queue state in Redis, history
in SQL — and a class of bugs where they disagree ("the job finished in Redis
but the row update failed"). With one store that bug can't exist.

What I gave up: push-based dispatch and raw throughput. Claim latency is
bounded by the poll interval (I added LISTEN/NOTIFY later to mostly fix
this, see below), and Postgres-as-queue tops out somewhere in the tens of
thousands of jobs per minute. For this system that's fine. If it ever
weren't, the claim query is the piece I'd swap for a broker — the schema and
lifecycle would survive that change.

## At-least-once, not exactly-once

I want to be upfront about this because it's the kind of thing that sounds
like a flaw but is actually a law of physics: a worker can always die *after*
sending the email but *before* recording that it did. No queue can tell those
two deaths apart, so "exactly-once execution" is not a promise I can make,
and I didn't try to fake it. What the system does guarantee:

- a job is never *concurrently* run by two workers (claims are atomic),
- submission is deduplicated via idempotency keys (unique index, so the
  database enforces it, not my code),
- a stale worker that comes back from the dead can't overwrite the result of
  the worker that replaced it — every completion write re-checks
  `status = 'running' AND claimed_by = me` in the WHERE clause,
- handlers are documented as needing to be idempotent, which is the standard
  contract for at-least-once systems.

## Workers talk to the database directly, not through the REST API

The workers are trusted internal infrastructure, so they use the DB as the
data plane; the REST API is the management plane for humans and external
clients. Routing worker traffic through HTTP would add a hop, a serialization
step and an auth story, and the atomic claim would have to move server-side
anyway to stay atomic. I couldn't find an upside.

## Where the cron scheduler lives, and why advisory locks

Cron enqueueing and dead-worker reaping run inside the API process on a 2s
tick. The obvious problem: run two API instances and every schedule fires
twice. Instead of adding a leader-election dependency, each tick takes
`pg_try_advisory_xact_lock` — whichever instance gets the lock does the work,
the rest skip that tick. As a second layer, every cron occurrence creates its
job with an idempotency key like `cron:<schedule-id>:<occurrence-time>`, so
even a crash halfway through a tick can't double-fire — the retried insert
hits the unique index and becomes a no-op.

One deliberate behavior: missed occurrences are not backfilled. If the
scheduler is down for an hour, an every-minute schedule runs once on recovery
and resumes cadence, rather than firing 60 times. For "send hourly digest"
semantics that's correct; a backfill mode would be a flag if someone needed it.

## Worker death doesn't count against the job

When the reaper requeues jobs from a dead worker, I don't increment
`attempts`. Infrastructure failure isn't the job's fault, and a flaky worker
shouldn't be able to push perfectly healthy jobs into the DLQ. The lost
attempt is still visible in `job_executions` as `status = 'lost'`, so the
history is honest even though the retry budget is preserved.

## Concurrency and rate limits: exact within a claim, soft across claims

Inside one claim statement the limits are exact — candidates are ranked
per queue with `row_number()` and only the ones that fit under
`max_concurrency` and `rate_limit_per_minute` survive. Across two workers
claiming at the same instant they're soft: each statement sees a snapshot
that doesn't include the other's uncommitted claim, so together they can
briefly exceed a limit. Making that strict would mean serializing all claims
per queue with a lock, which throws away exactly the parallelism SKIP LOCKED
exists to provide. Since these limits protect downstream systems from
*sustained* load, "occasionally one or two over for a single cycle" seemed
like the right trade, and I'd rather document that than hide it.

## Timeouts can't actually kill a handler

This is the limitation I'd fix first in production. A timed-out job is marked
`timed_out` and retried per policy, but Node can't forcibly cancel a running
promise — the handler keeps running in the background until it settles, and
its late result gets discarded by the `claimed_by` guard. The real fix is
running handlers in child processes or worker threads so a timeout can
actually kill them; I judged that out of scope here but the seam for it is
clean (it's all inside `worker.run`).

## Text + CHECK constraints instead of Postgres enums

Job/worker statuses are TEXT columns with CHECK constraints rather than
native enum types. Adding a state to a CHECK is a cheap constraint swap;
adding a value to an enum used to mean an `ALTER TYPE` migration with locking
implications. The enum situation in modern Postgres is better than its
reputation, but the CHECK approach has no downside I care about, so I took
the boring option.

## Postgres as the event bus too (LISTEN/NOTIFY)

Both of the "real-time" features ride on LISTEN/NOTIFY rather than a broker:
job creation fires `job_ready` (workers claim immediately instead of waiting
for the next poll tick) and every status transition fires `job_events`
(the API relays these to the dashboard over WebSocket). The important design
property: notifications are fire-and-forget, so nothing *correct* depends on
one arriving. If a worker's listener connection drops, the poll loop still
makes progress; if the dashboard's socket dies, the slow poll still refreshes.
Events buy latency, polling guarantees liveness.

## Workflow dependency semantics

A job with `depends_on` simply doesn't match the claim query until every
parent is `completed` — there's no separate "waiting" status to keep in sync,
the dependency check *is* the state. The uncomfortable question was what
happens when a parent dies. Leaving dependents queued forever is a silent
leak, so a recursive CTE cascade-cancels all transitive dependents with an
explanatory `last_error`. Parents must be in the same project; I validate
that at submission time.

## Sharding by queue, not by job

With `WORKER_SHARD_COUNT`/`WORKER_SHARD_INDEX` set, a worker group only
claims from queues whose id hashes into its shard. I shard whole queues
rather than individual jobs so per-queue ordering, concurrency and rate
limits keep meaning something within a shard. The cost is uneven load if one
queue dominates — acceptable, because the point of sharding here is reducing
claim contention, not load balancing.

## AI failure summaries had to work without credentials

The summary endpoint tries Claude, then Gemini, then falls back to a
deterministic heuristic (grouped error counts). Two reasons: whoever grades
this shouldn't need an API key to see the feature work, and an LLM outage
shouldn't be able to break an endpoint. The model only ever sees failure
metadata — job type, queue name, error text — never payloads, since payloads
can contain user data.

## Polling in the dashboard survived as the fallback, not the mechanism

The dashboard originally polled every few seconds; now it refreshes on
WebSocket events with a slow 10s poll as a safety net. I kept the poll
because the socket can die silently (proxies, laptop sleep) and a monitoring
dashboard that silently stops updating is worse than one that's a few
seconds stale.

## What I'd do next at scale

Partition `jobs` and `job_executions` by month and archive completed rows;
prune heartbeats older than a day; batch claims with adaptive poll intervals;
priority aging so low-priority jobs can't starve under sustained load.
