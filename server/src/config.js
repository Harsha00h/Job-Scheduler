require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT || '4000', 10),
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://localhost:5432/scheduler_dev',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
  // worker tuning
  workerConcurrency: parseInt(process.env.WORKER_CONCURRENCY || '5', 10),
  workerPollIntervalMs: parseInt(process.env.WORKER_POLL_INTERVAL_MS || '1000', 10),
  heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || '5000', 10),
  // a worker whose heartbeat is older than this is considered dead
  workerExpiryMs: parseInt(process.env.WORKER_EXPIRY_MS || '15000', 10),
  schedulerTickMs: parseInt(process.env.SCHEDULER_TICK_MS || '2000', 10),
  shutdownGraceMs: parseInt(process.env.SHUTDOWN_GRACE_MS || '30000', 10),
  // queue sharding: workers only claim from queues hashing to their shard
  shardCount: parseInt(process.env.WORKER_SHARD_COUNT || '1', 10),
  shardIndex: parseInt(process.env.WORKER_SHARD_INDEX || '0', 10),
  // optional: enables AI-generated failure summaries when either is set
  // (Anthropic is preferred if both are configured)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  geminiApiKey: process.env.GEMINI_API_KEY || null,
};
