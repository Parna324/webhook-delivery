import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import { requestIdMiddleware } from './middlewares/requestId.js';
import { requestLogger } from './middlewares/requestLogger.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { customerRouter } from './routes/customer.routes.js';
import { endpointRouter } from './routes/endpoint.routes.js';
import { eventRouter } from './routes/event.routes.js';
import { deliveryRouter } from './routes/delivery.routes.js';
import { NotFoundError } from '../lib/errors.js';
import { register } from '../lib/metrics.js';
import { prisma } from '../db/client.js';
import { redis } from '../lib/redis.js';

export const createApp = (): Express => {
  const app = express();

  // Basic security and parsing middlewares
  app.use(helmet({
    contentSecurityPolicy: false, // Allows lightweight inline styles/scripts for demo dashboard UI
  }));
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  // Tracing and request logging
  app.use(requestIdMiddleware);
  app.use(requestLogger);

  // Serve Dashboard UI
  const publicDir = path.resolve(process.cwd(), 'public');
  app.use('/dashboard', express.static(publicDir));
  app.get('/', (_req, res) => {
    res.redirect('/dashboard');
  });

  // 1. Liveness check (/health)
  app.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // 2. Readiness check (/ready) - validates PostgreSQL and Redis connectivity
  app.get('/ready', async (_req, res) => {
    try {
      await Promise.all([
        prisma.$queryRaw`SELECT 1`,
        redis.ping(),
      ]);

      res.status(200).json({
        status: 'ready',
        database: 'connected',
        redis: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(503).json({
        status: 'not_ready',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // 3. Prometheus Metrics endpoint (/metrics)
  app.get('/metrics', async (_req, res) => {
    try {
      res.setHeader('Content-Type', register.contentType);
      const metrics = await register.metrics();
      res.status(200).send(metrics);
    } catch (error) {
      res.status(500).send((error as Error).message);
    }
  });

  // 4. API v1 routers
  app.use('/v1', customerRouter);
  app.use('/v1/endpoints', endpointRouter);
  app.use('/v1/events', eventRouter);
  app.use('/v1/deliveries', deliveryRouter);

  // Catch-all 404 handler
  app.use((_req, _res, next) => {
    next(new NotFoundError('The requested resource was not found on this server'));
  });

  // Centralized error handler
  app.use(errorHandler);

  return app;
};
