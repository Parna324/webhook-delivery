import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { EventService } from '../../services/event.service.js';
import { RateLimiterService } from '../../services/rate-limiter.service.js';
import { apiKeyAuthMiddleware } from '../middlewares/auth.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';

export const eventRouter = Router();

eventRouter.use(apiKeyAuthMiddleware);

const ingestEventSchema = z.object({
  eventType: z.string().min(1, 'eventType is required (e.g. payment.succeeded)'),
  payload: z.record(z.string(), z.unknown(), {
    message: 'payload must be a valid JSON object',
  }),
});

/**
 * POST /v1/events
 * Ingests an event with atomic idempotency and fast 202 Accepted response
 */
eventRouter.post('/', async (req: Request, res: Response, next) => {
  try {
    const rawIdempotencyKey = req.header('idempotency-key');
    if (!rawIdempotencyKey || rawIdempotencyKey.trim().length === 0) {
      throw new BadRequestError('Missing required header: Idempotency-Key');
    }
    const idempotencyKey = rawIdempotencyKey.trim();

    // 1. Ingest Rate Limiting (500 req / 10s window)
    const rateLimit = await RateLimiterService.checkIngestRateLimit(req.customer!.id, 500, 10);
    res.setHeader('X-RateLimit-Limit', rateLimit.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimit.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimit.resetSeconds);

    if (!rateLimit.allowed) {
      res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Too many requests. Limit is ${rateLimit.limit} requests per ${rateLimit.resetSeconds}s.`,
        },
        requestId: req.id,
      });
      return;
    }

    // 2. Validate request body
    const body = ingestEventSchema.parse(req.body);

    // 3. Ingest and fan-out
    const result = await EventService.ingestEvent({
      customerId: req.customer!.id,
      idempotencyKey,
      eventType: body.eventType,
      payload: body.payload as Record<string, unknown>,
      requestPath: req.originalUrl,
    });

    res.status(result.statusCode).json(result.body);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/events
 * List customer events
 */
eventRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const events = await EventService.listEvents(req.customer!.id);
    res.status(200).json({ success: true, data: events });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/events/:id
 * Get single event with fanout delivery statuses
 */
eventRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const event = await EventService.getEvent(req.customer!.id, req.params.id as string);
    if (!event) {
      throw new NotFoundError('Event not found');
    }
    res.status(200).json({ success: true, data: event });
  } catch (error) {
    next(error);
  }
});
