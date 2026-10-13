import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { EndpointService } from '../../services/endpoint.service.js';
import { apiKeyAuthMiddleware } from '../middlewares/auth.js';

export const endpointRouter = Router();

endpointRouter.use(apiKeyAuthMiddleware);

const createEndpointSchema = z.object({
  url: z.string().url('Invalid webhook URL format'),
  description: z.string().optional(),
  secret: z.string().optional(),
  eventTypes: z.array(z.string()).optional(),
  rateLimitPerSecond: z.number().int().positive().optional(),
});

const updateEndpointSchema = z.object({
  url: z.string().url('Invalid webhook URL format').optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  eventTypes: z.array(z.string()).optional(),
  rateLimitPerSecond: z.number().int().positive().optional(),
});

/**
 * POST /v1/endpoints - Create new endpoint
 */
endpointRouter.post('/', async (req: Request, res: Response, next) => {
  try {
    const input = createEndpointSchema.parse(req.body);
    const endpoint = await EndpointService.createEndpoint(req.customer!.id, input);
    res.status(201).json({ success: true, data: endpoint });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/endpoints - List all endpoints for authenticated tenant
 */
endpointRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    const endpoints = await EndpointService.listEndpoints(req.customer!.id);
    res.status(200).json({ success: true, data: endpoints });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/endpoints/:id - Get endpoint details
 */
endpointRouter.get('/:id', async (req: Request, res: Response, next) => {
  try {
    const endpoint = await EndpointService.getEndpoint(req.customer!.id, req.params.id as string);
    res.status(200).json({ success: true, data: endpoint });
  } catch (error) {
    next(error);
  }
});

/**
 * PATCH /v1/endpoints/:id - Update endpoint
 */
endpointRouter.patch('/:id', async (req: Request, res: Response, next) => {
  try {
    const input = updateEndpointSchema.parse(req.body);
    const endpoint = await EndpointService.updateEndpoint(req.customer!.id, req.params.id as string, input);
    res.status(200).json({ success: true, data: endpoint });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /v1/endpoints/:id/rotate-secret - Rotate HMAC secret
 */
endpointRouter.post('/:id/rotate-secret', async (req: Request, res: Response, next) => {
  try {
    const endpoint = await EndpointService.rotateSecret(req.customer!.id, req.params.id as string);
    res.status(200).json({
      success: true,
      data: endpoint,
      message: 'Signing secret rotated. Please update your receiver with the new secret.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /v1/endpoints/:id - Delete endpoint
 */
endpointRouter.delete('/:id', async (req: Request, res: Response, next) => {
  try {
    await EndpointService.deleteEndpoint(req.customer!.id, req.params.id as string);
    res.status(200).json({ success: true, message: 'Endpoint deleted successfully' });
  } catch (error) {
    next(error);
  }
});
