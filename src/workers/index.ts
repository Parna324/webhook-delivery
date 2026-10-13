import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { DeliveryWorkerManager } from './delivery.worker.js';
import { redis } from '../lib/redis.js';
import { prisma } from '../db/client.js';

logger.info(
  {
    env: env.NODE_ENV,
    concurrency: env.WORKER_CONCURRENCY,
    deliveryTimeoutMs: env.DELIVERY_TIMEOUT_MS,
    maxRetries: env.MAX_DELIVERY_ATTEMPTS,
  },
  '⚙️ Delivery Worker process starting up...'
);

const workerManager = new DeliveryWorkerManager();
workerManager.start();

let isShuttingDown = false;

const shutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, `Received ${signal}. Shutting down worker gracefully...`);

  try {
    await workerManager.close();
    await redis.quit();
    await prisma.$disconnect();
    logger.info('Worker finished active jobs, drained queue, and exited cleanly.');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Worker uncaught exception! Exiting.');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Worker unhandled promise rejection! Exiting.');
  process.exit(1);
});
