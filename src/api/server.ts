import { createApp } from './app.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import http from 'node:http';

const app = createApp();
const server = http.createServer(app);

server.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      nodeVersion: process.version,
    },
    `🚀 Webhook Ingest & Management API started on port ${env.PORT}`
  );
});

const gracefulShutdown = (signal: string) => {
  logger.info({ signal }, `Received ${signal}. Gracefully stopping API server...`);
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'Error during server close');
      process.exit(1);
    }
    logger.info('API server closed successfully. Exiting process.');
    process.exit(0);
  });

  // Force shutdown if connections do not close in 10s
  setTimeout(() => {
    logger.error('Forced shutdown due to timeout closing open connections.');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception detected! Exiting process.');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection detected! Exiting process.');
  process.exit(1);
});
