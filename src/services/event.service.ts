import { createHash } from 'node:crypto';
import { prisma } from '../db/client.js';
import { QueueService } from './queue.service.js';
import { UnprocessableEntityError } from '../lib/errors.js';
import { eventsReceivedTotal } from '../lib/metrics.js';
import { logger } from '../lib/logger.js';
import { DeliveryStatus, Prisma } from '@prisma/client';

export interface IngestEventInput {
  customerId: string;
  idempotencyKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  requestPath?: string;
}

export interface IngestEventResult {
  isDuplicate: boolean;
  statusCode: number;
  body: {
    success: boolean;
    eventId?: string;
    deliveryCount?: number;
    message?: string;
  };
}

export class EventService {
  /**
   * Ingests a new webhook event with atomic idempotency reservation
   * to guarantee zero duplicates even under extreme concurrent race conditions.
   */
  static async ingestEvent(input: IngestEventInput): Promise<IngestEventResult> {
    const serializedPayload = JSON.stringify(input.payload);
    const requestHash = createHash('sha256').update(serializedPayload).digest('hex');
    const path = input.requestPath || '/v1/events';
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24-hour TTL

    // 1. Atomic Reservation via PostgreSQL UNIQUE constraint
    let idempotencyRecord;
    try {
      idempotencyRecord = await prisma.idempotencyKey.create({
        data: {
          customerId: input.customerId,
          key: input.idempotencyKey,
          requestPath: path,
          requestHash,
          expiresAt,
        },
      });
    } catch (err) {
      // Prisma P2002: Unique constraint failed on the fields: (`customer_id`, `key`)
      if ((err as { code?: string }).code === 'P2002') {
        const existing = await prisma.idempotencyKey.findUnique({
          where: {
            customerId_key: {
              customerId: input.customerId,
              key: input.idempotencyKey,
            },
          },
        });

        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new UnprocessableEntityError(
              `Idempotency-Key '${input.idempotencyKey}' was previously used with a different request payload.`
            );
          }

          // Return cached response if already completed
          if (existing.statusCode && existing.responseBody) {
            logger.info(
              { customerId: input.customerId, idempotencyKey: input.idempotencyKey, eventId: existing.eventId },
              'Idempotent request recognized. Returning cached response without duplicate fan-out.'
            );
            return {
              isDuplicate: true,
              statusCode: existing.statusCode,
              body: existing.responseBody as IngestEventResult['body'],
            };
          }

          // Concurrent in-flight request
          return {
            isDuplicate: true,
            statusCode: 202,
            body: {
              success: true,
              eventId: existing.eventId || undefined,
              message: 'Concurrent request detected with identical Idempotency-Key. Processing in-flight.',
            },
          };
        }
      }
      throw err;
    }

    // 2. Insert event & fan out to endpoints inside transaction
    const { event, deliveries } = await prisma.$transaction(async (tx) => {
      // Create Event
      const createdEvent = await tx.event.create({
        data: {
          customerId: input.customerId,
          eventType: input.eventType,
          payload: input.payload as unknown as Prisma.InputJsonValue,
        },
      });

      // Find all matching active endpoints for this customer
      const endpoints = await tx.endpoint.findMany({
        where: {
          customerId: input.customerId,
          enabled: true,
        },
      });

      const matchingEndpoints = endpoints.filter((ep) => {
        if (!ep.eventTypes || ep.eventTypes.length === 0) return true;
        return ep.eventTypes.includes('*') || ep.eventTypes.includes(input.eventType);
      });

      const createdDeliveries = [];
      for (const ep of matchingEndpoints) {
        const delivery = await tx.delivery.create({
          data: {
            customerId: input.customerId,
            eventId: createdEvent.id,
            endpointId: ep.id,
            status: DeliveryStatus.PENDING,
            attemptCount: 0,
            maxAttempts: 8,
          },
        });
        createdDeliveries.push({ delivery, endpoint: ep });
      }

      // Cache response in idempotency record
      const responseBody = {
        success: true,
        eventId: createdEvent.id,
        deliveryCount: createdDeliveries.length,
        message: `Event ingested. Delivery scheduled to ${createdDeliveries.length} endpoint(s).`,
      };

      await tx.idempotencyKey.update({
        where: { id: idempotencyRecord.id },
        data: {
          statusCode: 202,
          responseBody,
          eventId: createdEvent.id,
        },
      });

      return { event: createdEvent, deliveries: createdDeliveries };
    });

    // 3. Enqueue delivery jobs into BullMQ
    for (const item of deliveries) {
      await QueueService.enqueueDelivery({
        deliveryId: item.delivery.id,
        endpointId: item.endpoint.id,
        eventId: event.id,
        attemptNumber: 1,
      });
    }

    // 4. Record metric
    eventsReceivedTotal.inc({
      event_type: input.eventType,
      customer_id: input.customerId,
    });

    return {
      isDuplicate: false,
      statusCode: 202,
      body: {
        success: true,
        eventId: event.id,
        deliveryCount: deliveries.length,
        message: `Event accepted for asynchronous delivery to ${deliveries.length} destination(s).`,
      },
    };
  }

  static async getEvent(customerId: string, eventId: string) {
    return prisma.event.findFirst({
      where: { id: eventId, customerId },
      include: {
        deliveries: {
          include: {
            endpoint: {
              select: { id: true, url: true, description: true },
            },
            attempts: {
              orderBy: { attemptNumber: 'desc' },
              take: 5,
            },
          },
        },
      },
    });
  }

  static async listEvents(customerId: string, limit = 50) {
    return prisma.event.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        deliveries: {
          select: {
            id: true,
            status: true,
            attemptCount: true,
            endpoint: {
              select: { url: true },
            },
          },
        },
      },
    });
  }
}
