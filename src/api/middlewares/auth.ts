import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../db/client.js';
import { hashApiKey } from '../../lib/crypto.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export interface AuthenticatedCustomer {
  id: string;
  name: string;
  email: string;
}

export interface AuthenticatedApiKey {
  id: string;
  name: string;
  keyPrefix: string;
}

declare global {
  namespace Express {
    interface Request {
      customer?: AuthenticatedCustomer;
      apiKey?: AuthenticatedApiKey;
    }
  }
}

export const apiKeyAuthMiddleware = async (
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const rawHeader = req.header('x-api-key') || req.header('authorization');

    if (!rawHeader) {
      throw new UnauthorizedError('Missing authentication API key. Provide x-api-key header.');
    }

    // Support both "x-api-key: wh_live_..." and "Authorization: Bearer wh_live_..."
    const rawKey = rawHeader.startsWith('Bearer ') ? rawHeader.slice(7).trim() : rawHeader.trim();

    if (!rawKey.startsWith('wh_live_')) {
      throw new UnauthorizedError('Invalid API key format. Keys must start with "wh_live_".');
    }

    const keyHash = hashApiKey(rawKey);

    const apiKeyRecord = await prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!apiKeyRecord || !apiKeyRecord.isActive) {
      throw new UnauthorizedError('Invalid, revoked, or inactive API key.');
    }

    // Attach authenticated context to the request for strict tenant isolation
    req.customer = apiKeyRecord.customer;
    req.apiKey = {
      id: apiKeyRecord.id,
      name: apiKeyRecord.name,
      keyPrefix: apiKeyRecord.keyPrefix,
    };

    // Update lastUsedAt asynchronously in the background without blocking the request pipeline
    prisma.apiKey
      .update({
        where: { id: apiKeyRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err) => {
        logger.error({ err, apiKeyId: apiKeyRecord.id }, 'Failed to update API key lastUsedAt');
      });

    next();
  } catch (error) {
    next(error);
  }
};
