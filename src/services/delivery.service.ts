import { prisma } from '../db/client.js';
import { QueueService } from './queue.service.js';
import { NotFoundError, BadRequestError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { DeliveryStatus } from '@prisma/client';

export class DeliveryService {
  /**
   * Lists deliveries for a customer with optional status filtering (e.g. DEAD_LETTER)
   */
  static async listDeliveries(
    customerId: string,
    filter: { status?: DeliveryStatus; endpointId?: string; limit?: number } = {}
  ) {
    return prisma.delivery.findMany({
      where: {
        customerId,
        ...(filter.status && { status: filter.status }),
        ...(filter.endpointId && { endpointId: filter.endpointId }),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit ?? 50,
      include: {
        endpoint: {
          select: { id: true, url: true, description: true },
        },
        event: {
          select: { id: true, eventType: true, createdAt: true },
        },
        attempts: {
          orderBy: { attemptNumber: 'desc' },
          take: 1, // Latest attempt summary
        },
      },
    });
  }

  /**
   * Fetches delivery details along with all historical delivery attempts
   */
  static async getDelivery(customerId: string, deliveryId: string) {
    const delivery = await prisma.delivery.findFirst({
      where: { id: deliveryId, customerId },
      include: {
        endpoint: true,
        event: true,
        attempts: {
          orderBy: { attemptNumber: 'asc' },
        },
      },
    });

    if (!delivery) {
      throw new NotFoundError('Delivery record not found');
    }

    return delivery;
  }

  /**
   * Manually replays a failed or dead-letter delivery
   */
  static async replayDelivery(customerId: string, deliveryId: string) {
    const delivery = await this.getDelivery(customerId, deliveryId);

    if (delivery.status === DeliveryStatus.PROCESSING) {
      throw new BadRequestError('Delivery is currently being processed by a worker');
    }

    const nextAttemptNumber = delivery.attemptCount + 1;

    // Reset status to PENDING
    const updated = await prisma.delivery.update({
      where: { id: deliveryId },
      data: {
        status: DeliveryStatus.PENDING,
        nextRetryAt: null,
      },
    });

    // Re-enqueue to delivery queue
    await QueueService.enqueueDelivery({
      deliveryId: delivery.id,
      endpointId: delivery.endpointId,
      eventId: delivery.eventId,
      attemptNumber: nextAttemptNumber,
    });

    logger.info(
      { customerId, deliveryId, attemptNumber: nextAttemptNumber },
      '🔄 Delivery manually replayed from dead-letter / failed state'
    );

    return updated;
  }
}
