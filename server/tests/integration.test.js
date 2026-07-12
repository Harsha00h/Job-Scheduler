// Integration tests against a real PostgreSQL database (required: SKIP
// LOCKED semantics can't be faithfully mocked). Uses TEST_DATABASE_URL or
// postgres://localhost:5432/scheduler_test. Tables are truncated per run.
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
let queueId;

async function api(method, path, body) {
  const req = request(app)[method](path).set('Authorization', `Bearer ${token}`);
  return body ? req.send(body) : req;
}

beforeAll(async () => {
  await migrate();
  await query(
    `TRUNCATE users, organizations, organization_members, projects, retry_policies,
     queues, workers, worker_heartbeats, scheduled_jobs, jobs, job_executions,
     job_logs, dead_letter_jobs CASCADE`
  );

  const reg = await request(app).post('/api/auth/register').send({
    name: 'Test User',
    email: 'test@example.com',
    password: 'password123',
  });
  expect(reg.status).toBe(201);
  token = reg.body.token;

  const project = await api('post', '/api/projects', { name: 'Test Project' });
  expect(project.status).toBe(201);
  projectId = project.body.id;

  const queue = await api('post', `/api/projects/${projectId}/queues`, {
    name: 'test-queue',
    max_concurrency: 10,
  });
  expect(queue.status).toBe(201);
  queueId = queue.body.id;
});

afterAll(async () => {
  await pool.end();
});

describe('auth', () => {
  test('rejects requests without a token', async () => {
    const res = await request(app).get('/api/projects');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  test('rejects wrong password', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'test@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });
});

describe('job creation API', () => {
  test('creates an immediate job as queued', async () => {
    const res = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'math.sum',
      payload: { numbers: [1, 2, 3] },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('queued');
  });

  test('creates a delayed job as scheduled', async () => {
    const res = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'math.sum',
      payload: { numbers: [1] },
      delay_ms: 60000,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('scheduled');
  });

  test('validates the request body', async () => {
    const res = await api('post', `/api/queues/${queueId}/jobs`, { payload: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toContain('type is required');
  });

  test('idempotency key deduplicates submissions', async () => {
    const first = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'math.sum',
      payload: { numbers: [1] },
      idempotency_key: 'dedupe-me',
    });
    const second = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'math.sum',
      payload: { numbers: [999] },
      idempotency_key: 'dedupe-me',
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.deduplicated).toBe(true);
  });

  test('cannot access another user project', async () => {
    const other = await request(app).post('/api/auth/register').send({
      name: 'Other',
      email: 'other@example.com',
      password: 'password123',
    });
    const res = await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${other.body.token}`);
    expect(res.status).toBe(404); // not 403: existence is not leaked
  });
});

describe('atomic claiming', () => {
  test('concurrent claims never hand the same job to two workers', async () => {
    await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    for (let i = 0; i < 10; i++) {
      await createJob({ queueId, type: 'math.sum', payload: { numbers: [i] } });
    }
    const w1 = (await query(`INSERT INTO workers (name) VALUES ('w1') RETURNING id`)).rows[0].id;
    const w2 = (await query(`INSERT INTO workers (name) VALUES ('w2') RETURNING id`)).rows[0].id;

    const [a, b] = await Promise.all([claimJobs(w1, 10), claimJobs(w2, 10)]);
    const ids = [...a.map((j) => j.id), ...b.map((j) => j.id)];
    expect(new Set(ids).size).toBe(ids.length); // no overlap
    expect(ids.length).toBeLessThanOrEqual(10);
  });

  test('paused queues are never claimed from', async () => {
    await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    await createJob({ queueId, type: 'math.sum', payload: { numbers: [1] } });
    await api('post', `/api/queues/${queueId}/pause`);
    const w = (await query(`INSERT INTO workers (name) VALUES ('wp') RETURNING id`)).rows[0].id;
    expect(await claimJobs(w, 10)).toHaveLength(0);
    await api('post', `/api/queues/${queueId}/resume`);
    expect(await claimJobs(w, 10)).toHaveLength(1);
  });
});

describe('execution, retries and DLQ', () => {
  async function runWorkerOnce(worker) {
    await worker.poll();
    await Promise.allSettled([...worker.active.values()]);
  }

  test('a failing job is retried then dead-lettered, with full history', async () => {
    await query(`DELETE FROM jobs WHERE queue_id = $1`, [queueId]);
    const policy = await api('post', `/api/projects/${projectId}/retry-policies`, {
      name: 'fast-fixed',
      strategy: 'fixed',
      base_delay_ms: 0,
      max_attempts: 2,
    });
    await api('patch', `/api/queues/${queueId}`, { retry_policy_id: policy.body.id });

    const job = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'always.fail',
      payload: { message: 'boom' },
    });

    const worker = new Worker({ concurrency: 1 });
    await worker.register();
    await runWorkerOnce(worker); // attempt 1 -> retry scheduled
    let row = (await query('SELECT * FROM jobs WHERE id = $1', [job.body.id])).rows[0];
    expect(row.status).toBe('scheduled');
    expect(row.attempts).toBe(1);

    await runWorkerOnce(worker); // attempt 2 -> dead
    row = (await query('SELECT * FROM jobs WHERE id = $1', [job.body.id])).rows[0];
    expect(row.status).toBe('dead');
    expect(row.last_error).toBe('boom');

    const dlq = await api('get', `/api/projects/${projectId}/dlq`);
    expect(dlq.body.total).toBe(1);

    const detail = await api('get', `/api/jobs/${job.body.id}`);
    expect(detail.body.executions).toHaveLength(2);
    expect(detail.body.executions.every((e) => e.status === 'failed')).toBe(true);
  });

  test('a successful job records its result and duration', async () => {
    const job = await api('post', `/api/queues/${queueId}/jobs`, {
      type: 'math.sum',
      payload: { numbers: [2, 3, 5] },
    });
    const worker = new Worker({ concurrency: 1 });
    await worker.register();
    await runWorkerOnce(worker);

    const detail = await api('get', `/api/jobs/${job.body.id}`);
    expect(detail.body.status).toBe('completed');
    expect(detail.body.executions[0].status).toBe('succeeded');
    expect(detail.body.executions[0].result).toEqual({ sum: 10 });
  });

  test('DLQ replay resets the job for re-execution', async () => {
    const dlq = await api('get', `/api/projects/${projectId}/dlq`);
    const entry = dlq.body.data[0];
    const res = await api('post', `/api/dlq/${entry.id}/replay`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
    expect(res.body.attempts).toBe(0);
  });
});
