import { Router, Request, Response } from 'express';
import { DeliveryService } from '../../services/delivery.service.js';
import { apiKeyAuthMiddleware } from '../middlewares/auth.js';
import { DeliveryStatus } from '@prisma/client';

export const deliveryRouter = Router();

deliveryRouter.use(apiKeyAuthMiddleware);

/**
 * GET /v1/deliveries
 * Lists deliveries with optional filter by status (e.g. DEAD_LETTER, FAILED, SUCCESS)
 */
deliveryRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const status = req.query.status as DeliveryStatus | undefined;
    const endpointId = req.query.endpointId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const deliveries = await DeliveryService.listDeliveries(req.customer!.id, {
      status,
      endpointId,
      limit,
    });

    res.status(200).json({ success: true, data: deliveries });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/deliveries/:id
 * Detailed delivery view with historical attempts and response snippets
 */
deliveryRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const delivery = await DeliveryService.getDelivery(req.customer!.id, req.params.id as string);
    res.status(200).json({ success: true, data: delivery });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /v1/deliveries/:id/replay
 * Replays a failed or dead-letter delivery
 */
deliveryRouter.post('/:id/replay', async (req: Request, res: Response, next) => {
  try {
    const replayed = await DeliveryService.replayDelivery(req.customer!.id, req.params.id as string);
    res.status(200).json({
      success: true,
      data: replayed,
      message: 'Delivery successfully re-queued for immediate retry.',
    });
  } catch (error) {
    next(error);
  }
});
