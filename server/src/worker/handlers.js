// Job handlers, keyed by job type. Each receives (payload, ctx) where
// ctx.log(level, message) appends to the job's execution log.
// Handlers should be idempotent where possible: the system guarantees
// at-least-once execution, not exactly-once.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = {
  // generic demo job: configurable duration and failure rate
  'demo.sleep': async (payload, ctx) => {
    const ms = payload.duration_ms ?? 500;
    await ctx.log('info', `sleeping for ${ms}ms`);
    await sleep(ms);
    if (payload.fail_rate && Math.random() < payload.fail_rate) {
      throw new Error('simulated random failure');
    }
    return { slept_ms: ms };
  },

  'email.send': async (payload, ctx) => {
    if (!payload.to) throw new Error('payload.to is required');
    await ctx.log('info', `rendering template '${payload.template || 'default'}'`);
    await sleep(200 + Math.random() * 600);
    await ctx.log('info', `email sent to ${payload.to}`);
    return { to: payload.to, provider: 'simulated' };
  },

  'report.generate': async (payload, ctx) => {
    await ctx.log('info', `generating '${payload.report || 'summary'}' report`);
    await sleep(1000 + Math.random() * 2000);
    const rows = Math.floor(Math.random() * 5000);
    await ctx.log('info', `report ready with ${rows} rows`);
    return { rows };
  },

  // deterministic handler, useful for tests
  'math.sum': async (payload) => {
    if (!Array.isArray(payload.numbers)) throw new Error('payload.numbers must be an array');
    return { sum: payload.numbers.reduce((a, b) => a + b, 0) };
  },

  // always fails - demonstrates retry policies and the DLQ
  'always.fail': async (payload, ctx) => {
    await ctx.log('error', 'this handler always fails');
    throw new Error(payload.message || 'intentional failure');
  },
};
