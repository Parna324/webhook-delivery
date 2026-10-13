import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

const prismaClientSingleton = () => {
  const client = new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'error' },
            { emit: 'event', level: 'warn' },
          ]
        : [{ emit: 'event', level: 'error' }],
  });

  if (env.NODE_ENV === 'development') {
    client.$on('query', (e) => {
      // Log slow queries (> 100ms) or debug queries
      if (e.duration > 100) {
        logger.warn({ duration: e.duration, query: e.query }, 'Slow DB query detected');
      } else {
        logger.debug({ duration: e.duration, query: e.query }, 'DB query executed');
      }
    });
  }

  client.$on('error', (e) => {
    logger.error({ target: e.target, message: e.message }, 'Database client error');
  });

  return client;
};

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: undefined | ReturnType<typeof prismaClientSingleton>;
}

export const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

if (env.NODE_ENV !== 'production') {
  globalThis.prismaGlobal = prisma;
}
