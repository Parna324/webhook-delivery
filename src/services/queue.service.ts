import { Queue } from 'bullmq';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { queueDepthGauge } from '../lib/metrics.js';

export interface DeliveryJobData {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  attemptNumber: number;
}

export const DELIVERY_QUEUE_NAME = 'webhook-deliveries';

// Create BullMQ Queue instance
export const deliveryQueue = new Queue<DeliveryJobData>(DELIVERY_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 1, // We control exponential backoff manually via Delivery records
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export class QueueService {
  /**
   * Enqueues a delivery job into BullMQ, optionally with backoff delay
   */
  static async enqueueDelivery(data: DeliveryJobData, delayMs = 0): Promise<string> {
    const job = await deliveryQueue.add('deliver', data, {
      delay: delayMs,
      jobId: `${data.deliveryId}-attempt-${data.attemptNumber}`,
    });

    logger.debug(
      { jobId: job.id, deliveryId: data.deliveryId, attempt: data.attemptNumber, delayMs },
      'Enqueued delivery job to queue'
    );

    // Update queue metric asynchronously
    this.updateQueueMetrics().catch(() => {});

    return job.id || '';
  }

  /**
   * Updates Prometheus queue depth metrics
   */
  static async updateQueueMetrics(): Promise<void> {
    try {
      const counts = await deliveryQueue.getJobCounts('waiting', 'active', 'delayed', 'failed');
      queueDepthGauge.set({ queue_name: DELIVERY_QUEUE_NAME, state: 'waiting' }, counts.waiting ?? 0);
      queueDepthGauge.set({ queue_name: DELIVERY_QUEUE_NAME, state: 'active' }, counts.active ?? 0);
      queueDepthGauge.set({ queue_name: DELIVERY_QUEUE_NAME, state: 'delayed' }, counts.delayed ?? 0);
      queueDepthGauge.set({ queue_name: DELIVERY_QUEUE_NAME, state: 'failed' }, counts.failed ?? 0);
    } catch {
      // Ignore transient metric polling errors
    }
  }
}
