import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { CustomerService } from '../../services/customer.service.js';
import { apiKeyAuthMiddleware } from '../middlewares/auth.js';

export const customerRouter = Router();

const createCustomerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
});

const createApiKeySchema = z.object({
  name: z.string().min(2, 'Key name must be at least 2 characters').default('API Key'),
});

/**
 * POST /v1/customers
 * Onboards a customer and returns their initial live API key (shown only once)
 */
customerRouter.post('/customers', async (req: Request, res: Response, next) => {
  try {
    const input = createCustomerSchema.parse(req.body);
    const result = await CustomerService.createCustomer(input);
    res.status(201).json({
      success: true,
      data: result,
      message: 'Customer onboarded successfully. Please securely store the rawKey; it cannot be recovered later.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /v1/me
 * Authenticated route to verify API key identity and customer profile
 */
customerRouter.get('/me', apiKeyAuthMiddleware, async (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      customer: req.customer,
      apiKey: req.apiKey,
    },
  });
});

/**
 * GET /v1/api-keys
 * Lists all API keys for the authenticated tenant
 */
customerRouter.get('/api-keys', apiKeyAuthMiddleware, async (req: Request, res: Response, next) => {
  try {
    const keys = await CustomerService.listApiKeys(req.customer!.id);
    res.status(200).json({
      success: true,
      data: keys,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /v1/api-keys
 * Creates a new API key for the authenticated customer
 */
customerRouter.post('/api-keys', apiKeyAuthMiddleware, async (req: Request, res: Response, next) => {
  try {
    const input = createApiKeySchema.parse(req.body);
    const result = await CustomerService.createApiKey(req.customer!.id, input.name);
    res.status(201).json({
      success: true,
      data: result,
      message: 'New API key created. Copy the rawKey now; it will not be displayed again.',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /v1/api-keys/:id
 * Revokes an existing API key
 */
customerRouter.delete('/api-keys/:id', apiKeyAuthMiddleware, async (req: Request, res: Response, next) => {
  try {
    const apiKeyId = req.params.id as string;
    await CustomerService.revokeApiKey(req.customer!.id, apiKeyId);
    res.status(200).json({
      success: true,
      message: 'API key revoked successfully',
    });
  } catch (error) {
    next(error);
  }
});
