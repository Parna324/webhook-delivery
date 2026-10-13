import { prisma } from '../db/client.js';
import { generateApiKey } from '../lib/crypto.js';
import { ConflictError, NotFoundError } from '../lib/errors.js';

export interface CreateCustomerInput {
  name: string;
  email: string;
}

export interface CreatedApiKeyOutput {
  id: string;
  name: string;
  keyPrefix: string;
  rawKey: string;
  createdAt: Date;
}

export class CustomerService {
  /**
   * Registers a new customer and issues an initial API key
   */
  static async createCustomer(input: CreateCustomerInput): Promise<{
    customer: { id: string; name: string; email: string; createdAt: Date };
    apiKey: CreatedApiKeyOutput;
  }> {
    const existing = await prisma.customer.findUnique({
      where: { email: input.email },
    });

    if (existing) {
      throw new ConflictError(`Customer with email '${input.email}' already exists`);
    }

    const { rawKey, keyPrefix, keyHash } = generateApiKey();

    const result = await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          name: input.name,
          email: input.email,
        },
      });

      const apiKey = await tx.apiKey.create({
        data: {
          customerId: customer.id,
          name: 'Default API Key',
          keyPrefix,
          keyHash,
        },
      });

      return {
        customer: {
          id: customer.id,
          name: customer.name,
          email: customer.email,
          createdAt: customer.createdAt,
        },
        apiKey: {
          id: apiKey.id,
          name: apiKey.name,
          keyPrefix: apiKey.keyPrefix,
          rawKey, // Only revealed once!
          createdAt: apiKey.createdAt,
        },
      };
    });

    return result;
  }

  /**
   * Generates a new API key for an existing customer
   */
  static async createApiKey(customerId: string, name: string): Promise<CreatedApiKeyOutput> {
    const customer = await prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!customer) {
      throw new NotFoundError('Customer not found');
    }

    const { rawKey, keyPrefix, keyHash } = generateApiKey();

    const apiKey = await prisma.apiKey.create({
      data: {
        customerId,
        name: name || 'API Key',
        keyPrefix,
        keyHash,
      },
    });

    return {
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      rawKey,
      createdAt: apiKey.createdAt,
    };
  }

  /**
   * Lists all API keys for a customer (safe metadata only, no secrets or hashes)
   */
  static async listApiKeys(customerId: string) {
    return prisma.apiKey.findMany({
      where: { customerId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        isActive: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Revokes an API key belonging to a customer
   */
  static async revokeApiKey(customerId: string, apiKeyId: string): Promise<void> {
    const key = await prisma.apiKey.findFirst({
      where: { id: apiKeyId, customerId },
    });

    if (!key) {
      throw new NotFoundError('API key not found');
    }

    await prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { isActive: false },
    });
  }
}
