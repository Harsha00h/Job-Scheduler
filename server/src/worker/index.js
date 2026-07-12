const { Worker } = require('./worker');
const logger = require('../lib/logger');

async function main() {
  const worker = new Worker();
  await worker.register();
  worker.start();

  const stop = async (signal) => {
    logger.info('signal received', { signal });
    await worker.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((err) => {
  logger.error('worker failed to start', { err: err.message });
  process.exit(1);
});
