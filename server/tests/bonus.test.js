// Tests for workflow dependencies, rate limiting, strict per-statement
// concurrency, queue sharding, and the failure-summary endpoint.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/scheduler_test';

const request = require('supertest');
const app = require('../src/app');
const { pool, query } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { claimJobs } = require('../src/worker/claim');
const { Worker } = require('../src/worker/worker');
const { createJob } = require('../src/services/jobs');

let token;
let projectId;

async function api(method, path, body) {
  const req = request(app)[method](path).set('Authorization', `Bearer ${token}`);
  return body ? req.send(body) : req;
}

async function makeQueue(fields = {}) {
  const res = await api('post', `/api/projects/${projectId}/queues`, {
    name: `q-${Math.random().toString(36).slice(2, 8)}`,
    ...fields,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function makeWorker() {
  return (await query(`INSERT INTO workers (name) VALUES ('bonus-w') RETURNING id`)).rows[0].id;
}

beforeAll(async () => {
  await migrate();
  await query(
    `TRUNCATE users, organizations, organization_members, projects, retry_policies,
     queues, workers, worker_heartbeats, scheduled_jobs, jobs, job_dependencies,
     job_executions, job_logs, dead_letter_jobs CASCADE`
  );
  const reg = await request(app).post('/api/auth/register').send({
    name: 'Bonus Tester',
    email: 'bonus@example.com',
    password: 'password123',
  });
  token = reg.body.token;
  const project = await api('post', '/api/projects', { name: 'Bonus Project' });
  projectId = project.body.id;
});

afterAll(async () => {
  await pool.end();
});

describe('workflow dependencies', () => {
  test('a job is not claimable until its dependencies complete', async () => {
    const queueId = await makeQueue({ max_concurrency: 10 });
    const parent = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'math.sum',
      payload: { numbers: [1] },
    });
    const child = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'math.sum',
      payload: { numbers: [2] },
      depends_on: [parent.body.id],
    });
    expect(child.status).toBe(201);

    const w = await makeWorker();
    const first = await claimJobs(w, 10);
    expect(first.map((j) => j.id)).toEqual([parent.body.id]); // child held back

    await query(`UPDATE jobs SET status = 'completed' WHERE id = $1`, [parent.body.id]);
    const second = await claimJobs(w, 10);
    expect(second.map((j) => j.id)).toEqual([child.body.id]); // now claimable
  });

  test('dependents are cascade-cancelled when a dependency dies', async () => {
    const queueId = await makeQueue({ max_concurrency: 10 });
    const parent = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'always.fail',
      max_attempts: 1,
    });
    const child = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'math.sum',
      payload: { numbers: [1] },
      depends_on: [parent.body.id],
    });
    const grandchild = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'math.sum',
      payload: { numbers: [2] },
      depends_on: [child.body.id],
    });

    const worker = new Worker({ concurrency: 1 });
    await worker.register();
    await worker.poll();
    await Promise.allSettled([...worker.active.values()]);

    const { rows } = await query(`SELECT id, status FROM jobs WHERE id = ANY($1)`, [
      [parent.body.id, child.body.id, grandchild.body.id],
    ]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    expect(byId[parent.body.id]).toBe('dead');
    expect(byId[child.body.id]).toBe('cancelled'); // direct dependent
    expect(byId[grandchild.body.id]).toBe('cancelled'); // transitive dependent
  });

  test('depends_on referencing an unknown job is rejected', async () => {
    const queueId = await makeQueue({});
    const res = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'math.sum',
      payload: { numbers: [1] },
      depends_on: ['00000000-0000-0000-0000-000000000000'],
    });
    expect(res.status).toBe(400);
  });
});

describe('rate limiting', () => {
  test('claims are capped by the queue rate limit', async () => {
    const queueId = await makeQueue({ max_concurrency: 100, rate_limit_per_minute: 2 });
    for (let i = 0; i < 5; i++) {
      await createJob({ queueId, type: 'math.sum', payload: { numbers: [i] } });
    }
    const w = await makeWorker();
    const claimed = await claimJobs(w, 10);
    expect(claimed).toHaveLength(2);
  });
});

describe('per-queue concurrency (single statement)', () => {
  test('one claim never exceeds max_concurrency for a queue', async () => {
    const queueId = await makeQueue({ max_concurrency: 3 });
    for (let i = 0; i < 5; i++) {
      await createJob({ queueId, type: 'math.sum', payload: { numbers: [i] } });
    }
    const w = await makeWorker();
    expect(await claimJobs(w, 10)).toHaveLength(3);
  });
});

describe('queue sharding', () => {
  test('two shards partition the queues with no overlap', async () => {
    const queueA = await makeQueue({ max_concurrency: 10 });
    const queueB = await makeQueue({ max_concurrency: 10 });
    const jobs = [];
    for (const queueId of [queueA, queueB]) {
      for (let i = 0; i < 3; i++) {
        const { job } = await createJob({ queueId, type: 'math.sum', payload: { numbers: [i] } });
        jobs.push(job.id);
      }
    }
    const w1 = await makeWorker();
    const w2 = await makeWorker();
    const shard0 = await claimJobs(w1, 10, { count: 2, index: 0 });
    const shard1 = await claimJobs(w2, 10, { count: 2, index: 1 });

    const ids0 = new Set(shard0.map((j) => j.id));
    const ids1 = new Set(shard1.map((j) => j.id));
    for (const id of ids0) expect(ids1.has(id)).toBe(false); // disjoint
    expect(ids0.size + ids1.size).toBe(jobs.length); // together they cover everything
  });
});

describe('failure summaries', () => {
  test('returns a heuristic summary without an API key', async () => {
    const res = await api('get', `/api/projects/${projectId}/failure-summary`);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('heuristic');
    expect(res.body.failure_count).toBeGreaterThanOrEqual(1); // always.fail above
    expect(res.body.summary).toContain('always.fail');
  });
});
