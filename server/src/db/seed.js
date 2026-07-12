// Seeds a demo user, project, retry policies, queues, a cron schedule and
// a mix of jobs so the dashboard has something to show immediately.
// Login: demo@example.com / password123
const bcrypt = require('bcryptjs');
const { pool, query, withTransaction } = require('./index');
const { createJob } = require('../services/jobs');

async function seed() {
  const existing = await query('SELECT 1 FROM users WHERE email = $1', ['demo@example.com']);
  if (existing.rows.length) {
    console.log('demo data already present, skipping');
    return;
  }

  const ids = await withTransaction(async (tx) => {
    const hash = await bcrypt.hash('password123', 10);
    const user = (
      await tx.query(
        `INSERT INTO users (email, password_hash, name) VALUES ('demo@example.com', $1, 'Demo User') RETURNING id`,
        [hash]
      )
    ).rows[0];
    const org = (
      await tx.query(`INSERT INTO organizations (name) VALUES ('Demo Org') RETURNING id`)
    ).rows[0];
    await tx.query(
      `INSERT INTO organization_members (org_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [org.id, user.id]
    );
    const project = (
      await tx.query(
        `INSERT INTO projects (org_id, name, description)
         VALUES ($1, 'Demo Project', 'Seeded demo project') RETURNING id`,
        [org.id]
      )
    ).rows[0];

    const expo = (
      await tx.query(
        `INSERT INTO retry_policies (project_id, name, strategy, base_delay_ms, max_delay_ms, max_attempts)
         VALUES ($1, 'aggressive-exponential', 'exponential', 500, 60000, 4) RETURNING id`,
        [project.id]
      )
    ).rows[0];
    const fixed = (
      await tx.query(
        `INSERT INTO retry_policies (project_id, name, strategy, base_delay_ms, max_delay_ms, max_attempts)
         VALUES ($1, 'gentle-fixed', 'fixed', 5000, 5000, 2) RETURNING id`,
        [project.id]
      )
    ).rows[0];

    const emails = (
      await tx.query(
        `INSERT INTO queues (project_id, name, priority, max_concurrency, timeout_ms, retry_policy_id)
         VALUES ($1, 'emails', 10, 5, 30000, $2) RETURNING id`,
        [project.id, expo.id]
      )
    ).rows[0];
    const reports = (
      await tx.query(
        `INSERT INTO queues (project_id, name, priority, max_concurrency, timeout_ms, retry_policy_id)
         VALUES ($1, 'reports', 0, 2, 120000, $2) RETURNING id`,
        [project.id, fixed.id]
      )
    ).rows[0];

    await tx.query(
      `INSERT INTO scheduled_jobs (queue_id, name, cron_expression, job_type, payload, next_run_at)
       VALUES ($1, 'minutely-health-report', '* * * * *', 'report.generate',
               '{"report": "health"}', now())`,
      [reports.id]
    );
    return { emails: emails.id, reports: reports.id };
  });

  // a spread of jobs: immediate emails, a delayed one, a couple of failures
  for (let i = 1; i <= 8; i++) {
    await createJob({
      queueId: ids.emails,
      type: 'email.send',
      payload: { to: `user${i}@example.com`, template: 'welcome' },
      idempotencyKey: `seed-email-${i}`,
    });
  }
  await createJob({
    queueId: ids.emails,
    type: 'email.send',
    payload: { to: 'later@example.com', template: 'digest' },
    runAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    idempotencyKey: 'seed-delayed-email',
  });
  await createJob({
    queueId: ids.emails,
    type: 'always.fail',
    payload: { message: 'demo DLQ entry' },
    idempotencyKey: 'seed-dlq-demo',
  });
  await createJob({
    queueId: ids.reports,
    type: 'demo.sleep',
    payload: { duration_ms: 1500, fail_rate: 0.3 },
    idempotencyKey: 'seed-flaky-job',
  });

  console.log('seeded demo data. login: demo@example.com / password123');
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .catch((err) => {
      console.error('seed failed:', err.message);
      process.exit(1);
    });
}
