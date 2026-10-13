import { prisma } from '../db/client.js';
import { generateEndpointSecret } from '../lib/signature.js';
import { validateWebhookUrl } from '../lib/ssrf.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { env } from '../config/env.js';

export interface CreateEndpointInput {
  url: string;
  description?: string;
  secret?: string;
  eventTypes?: string[];
  rateLimitPerSecond?: number;
}

export interface UpdateEndpointInput {
  url?: string;
  description?: string;
  enabled?: boolean;
  eventTypes?: string[];
  rateLimitPerSecond?: number;
}

export class EndpointService {
  /**
   * Registers a new webhook destination endpoint for a customer
   */
  static async createEndpoint(customerId: string, input: CreateEndpointInput) {
    // Validate target URL against SSRF
    const ssrfCheck = await validateWebhookUrl(input.url, {
      allowLocal: env.NODE_ENV !== 'production' || process.env.ALLOW_LOCAL_WEBHOOKS === 'true',
    });

    if (!ssrfCheck.valid) {
      throw new BadRequestError(`Invalid webhook URL: ${ssrfCheck.reason}`);
    }

    const secret = input.secret || generateEndpointSecret();
    const eventTypes = input.eventTypes && input.eventTypes.length > 0 ? input.eventTypes : ['*'];

    const endpoint = await prisma.endpoint.create({
      data: {
        customerId,
        url: input.url,
        description: input.description,
        secret,
        eventTypes,
        rateLimitPerSecond: input.rateLimitPerSecond ?? 50,
      },
    });

    return endpoint;
  }

  /**
   * Lists all endpoints registered by a customer
   */
  static async listEndpoints(customerId: string) {
    return prisma.endpoint.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Fetches an endpoint by ID, ensuring tenant isolation
   */
  static async getEndpoint(customerId: string, endpointId: string) {
    const endpoint = await prisma.endpoint.findFirst({
      where: { id: endpointId, customerId },
    });

    if (!endpoint) {
      throw new NotFoundError('Webhook endpoint not found');
    }

    return endpoint;
  }

  /**
   * Updates an endpoint
   */
  static async updateEndpoint(customerId: string, endpointId: string, input: UpdateEndpointInput) {
    await this.getEndpoint(customerId, endpointId);

    if (input.url) {
      const ssrfCheck = await validateWebhookUrl(input.url, {
        allowLocal: env.NODE_ENV !== 'production' || process.env.ALLOW_LOCAL_WEBHOOKS === 'true',
      });
      if (!ssrfCheck.valid) {
        throw new BadRequestError(`Invalid webhook URL: ${ssrfCheck.reason}`);
      }
    }

    return prisma.endpoint.update({
      where: { id: endpointId },
      data: {
        ...(input.url && { url: input.url }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.enabled !== undefined && { enabled: input.enabled }),
        ...(input.eventTypes && { eventTypes: input.eventTypes }),
        ...(input.rateLimitPerSecond !== undefined && { rateLimitPerSecond: input.rateLimitPerSecond }),
      },
    });
  }

  /**
   * Rotates the HMAC signing secret for an endpoint
   */
  static async rotateSecret(customerId: string, endpointId: string) {
    await this.getEndpoint(customerId, endpointId);
    const newSecret = generateEndpointSecret();

    return prisma.endpoint.update({
      where: { id: endpointId },
      data: { secret: newSecret },
    });
  }

  /**
   * Deletes an endpoint
   */
  static async deleteEndpoint(customerId: string, endpointId: string) {
    await this.getEndpoint(customerId, endpointId);
    await prisma.endpoint.delete({ where: { id: endpointId } });
  }
}
